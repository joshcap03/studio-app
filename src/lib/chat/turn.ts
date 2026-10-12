import { z } from "zod";
import { AgentError, type AgentAdapter } from "@/lib/agent/types";
import type { Store } from "@/lib/db/store";
import {
  ARTIFACT_KINDS,
  type ActivityStep,
  type Artifact,
  type ChatMessage,
  type ConversationSummary,
  type MessageStatus,
  type StreamEvent,
} from "@/lib/types";

// Runs one conversational turn: persists the user's message, drives the agent adapter,
// streams normalized events to the browser, and persists the assistant's final state no
// matter how the run ends (finished, failed, timed out, or stopped).

export class TurnError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type TurnRequest =
  | { userId: string; conversationId: string; kind: "send"; text: string }
  | { userId: string; conversationId: string; kind: "retry" };

export interface TurnDeps {
  store: Store;
  adapter: AgentAdapter;
  idleTimeoutMs: number;
  /** How often partial output is saved while streaming. */
  checkpointMs?: number;
}

const globalRuns = globalThis as unknown as { __workspaceRuns?: Map<string, AbortController> };
const activeRuns = (globalRuns.__workspaceRuns ??= new Map());

/** True while a run for this conversation is in flight in this server process. */
export function isRunActive(conversationId: string): boolean {
  return activeRuns.has(conversationId);
}

/** Messages left `streaming` by a run that no longer exists are shown as interrupted. */
export function withLiveStatus(messages: ChatMessage[], conversationId: string): ChatMessage[] {
  if (isRunActive(conversationId)) return messages;
  return messages.map((m) => (m.status === "streaming" ? { ...m, status: "interrupted" } : m));
}

export function titleFromMessage(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= 60) return line || "New conversation";
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return `${(space > 30 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const artifactSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(ARTIFACT_KINDS).catch("file"),
  title: z.string().min(1).max(300),
  description: z.string().max(500).optional(),
  source: z.string().max(100).optional(),
  url: z
    .url({ protocol: /^https$/ })
    .max(4000)
    .optional()
    .catch(undefined),
});

/** Only well-formed artifacts with https links reach the browser. */
export function sanitizeArtifact(value: unknown): Artifact | null {
  const parsed = artifactSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function startTurn(deps: TurnDeps, request: TurnRequest, requestSignal: AbortSignal): ReadableStream<Uint8Array> {
  const { store, adapter } = deps;
  const { userId, conversationId } = request;

  if (activeRuns.has(conversationId)) {
    throw new TurnError(409, "The agent is still working in this conversation.");
  }

  const now = Date.now();
  let conversation = store.getConversation(userId, conversationId);
  let userMessage: ChatMessage | null = null;
  let prompt: string;

  if (request.kind === "retry") {
    if (!conversation) throw new TurnError(404, "Conversation not found.");
    const messages = store.listMessages(conversationId);
    const last = messages.at(-1);
    if (last?.role === "assistant") {
      if (last.status === "complete") throw new TurnError(409, "The last response finished; there is nothing to retry.");
      store.deleteMessage(last.id);
    }
    const lastUser = messages.findLast((m) => m.role === "user");
    if (!lastUser) throw new TurnError(400, "There is no message to retry.");
    prompt = lastUser.content;
  } else {
    if (!conversation) {
      conversation = store.createConversation(userId, {
        id: conversationId,
        title: titleFromMessage(request.text),
        now,
      });
    }
    userMessage = {
      id: crypto.randomUUID(),
      conversationId,
      role: "user",
      content: request.text,
      status: "complete",
      activity: [],
      artifacts: [],
      createdAt: now,
    };
    store.insertMessage(userMessage);
    prompt = request.text;
  }

  // Prior completed turns, excluding the message being answered now.
  const prior = store.listMessages(conversationId);
  const promptIndex = prior.findLastIndex((m) => m.role === "user");
  const history = prior
    .slice(0, promptIndex)
    .filter((m) => m.status === "complete" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));

  const assistant: ChatMessage = {
    id: crypto.randomUUID(),
    conversationId,
    role: "assistant",
    content: "",
    status: "streaming",
    activity: [],
    artifacts: [],
    createdAt: now + 1,
  };
  store.insertMessage(assistant);

  const controller = new AbortController();
  activeRuns.set(conversationId, controller);
  if (requestSignal.aborted) controller.abort();
  else requestSignal.addEventListener("abort", () => controller.abort(), { once: true });

  const threadId = conversation.agentThreadId;
  const summary: ConversationSummary = {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(stream) {
      let open = true;
      const send = (event: StreamEvent) => {
        if (!open) return;
        try {
          stream.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false;
        }
      };

      let content = "";
      const activity: ActivityStep[] = [];
      const artifacts: Artifact[] = [];
      let status: MessageStatus = "complete";
      let error: string | null = null;
      let lastCheckpoint = Date.now();

      send({ type: "start", conversation: summary, userMessage, assistantMessage: assistant });

      try {
        const events = adapter.run({ threadId, message: prompt, history, signal: controller.signal });
        for await (const event of withIdleTimeout(events, deps.idleTimeoutMs, controller.signal)) {
          switch (event.type) {
            case "thread":
              if (event.threadId && event.threadId !== threadId) store.setAgentThreadId(conversationId, event.threadId);
              break;
            case "text-delta":
              content += event.text;
              send({ type: "text", delta: event.text });
              break;
            case "message":
              content = event.text;
              send({ type: "text-replace", text: event.text });
              break;
            case "activity": {
              const at = Date.now();
              const existing = activity.find((s) => s.id === event.id);
              const step: ActivityStep = {
                id: event.id,
                label: event.label,
                status: event.status,
                detail: event.detail,
                startedAt: existing?.startedAt ?? at,
                endedAt: event.status === "running" ? undefined : at,
              };
              if (existing) activity[activity.indexOf(existing)] = step;
              else activity.push(step);
              send({ type: "activity", step });
              break;
            }
            case "artifact": {
              const artifact = sanitizeArtifact(event.artifact);
              if (artifact && !artifacts.some((a) => a.id === artifact.id)) {
                artifacts.push(artifact);
                send({ type: "artifact", artifact });
              }
              break;
            }
          }
          const checkpointMs = deps.checkpointMs ?? 2000;
          if (Date.now() - lastCheckpoint > checkpointMs) {
            store.updateMessage(assistant.id, { content, activity, artifacts });
            lastCheckpoint = Date.now();
          }
        }
        if (!content.trim() && artifacts.length === 0) {
          status = "error";
          error = "The agent finished without a response.";
        }
      } catch (e) {
        if (e instanceof AgentError) {
          status = "error";
          error = e.message;
        } else if (controller.signal.aborted) {
          status = "stopped";
        } else {
          status = "error";
          error = "Something went wrong while the agent was working.";
          console.error("[turn] agent run failed", e);
        }
      } finally {
        if (!controller.signal.aborted) controller.abort();
        activeRuns.delete(conversationId);
      }

      store.updateMessage(assistant.id, { content, status, activity, artifacts, error });
      const updated = store.touchConversation(conversationId);
      send({
        type: "end",
        message: { ...assistant, content, status, activity, artifacts, error },
        conversation: updated,
      });
      if (open) {
        try {
          stream.close();
        } catch {
          // client already gone
        }
      }
    },
    cancel() {
      controller.abort();
    },
  });
}

/** Fails the run if the agent goes quiet for longer than `ms`, and stops on abort. */
async function* withIdleTimeout<T>(source: AsyncIterable<T>, ms: number, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  aborted.catch(() => {});
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new AgentError("The agent stopped responding. Try again in a moment.")),
          ms,
        );
      });
      try {
        const result = await Promise.race([iterator.next(), idle, aborted]);
        if (result.done) return;
        yield result.value;
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    iterator.return?.()?.catch(() => {});
  }
}

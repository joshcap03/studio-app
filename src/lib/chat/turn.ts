import { z } from "zod";
import { AgentError, type AgentAdapter, type AgentTenantContext } from "@/lib/agent/types";
import { STALE_STREAM_MS, type Store } from "@/lib/db/store";
import { renderSkillMessage } from "@/lib/skills/render";
import {
  ARTIFACT_KINDS,
  type ActivityStep,
  type Artifact,
  type ChatMessage,
  type ConversationSummary,
  type MessageStatus,
  type StreamEvent,
} from "@/lib/types";

// Runs one conversational turn for one tenant: persists the user's message, drives the
// agent adapter with the tenant's context, streams normalized events to the browser, and
// persists the assistant's final state however the run ends (finished, failed, timed out,
// or stopped). The store is already scoped to the caller's workspace and user.

export class TurnError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A workspace skill attached to a message, loaded by the server from the caller's workspace. */
export interface TurnSkill {
  id: string;
  name: string;
  instructions: string;
}

export type TurnRequest = { conversationId: string } & ({ kind: "send"; text: string; skill?: TurnSkill } | { kind: "retry" });

export interface TurnDeps {
  store: Store;
  adapter: AgentAdapter;
  context: AgentTenantContext;
  idleTimeoutMs: number;
  /** Loads a skill from the caller's workspace, for retrying a message sent with one. */
  loadSkill?: (id: string) => Promise<TurnSkill | null>;
  /** How often partial output is saved while streaming. */
  checkpointMs?: number;
  /** Heartbeat that keeps a quiet-but-alive run from looking interrupted. */
  heartbeatMs?: number;
}

const globalRuns = globalThis as unknown as { __workspaceRuns?: Map<string, AbortController> };
const activeRuns = (globalRuns.__workspaceRuns ??= new Map());

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

/**
 * Stops a run in progress. Runs are not tied to the browser connection: closing or reloading
 * the page leaves the agent working (its progress keeps being saved); only this stops it.
 */
export function stopRun(workspaceId: string, conversationId: string): boolean {
  const controller = activeRuns.get(`${workspaceId}:${conversationId}`);
  if (!controller) return false;
  controller.abort();
  return true;
}

export async function startTurn(deps: TurnDeps, request: TurnRequest): Promise<ReadableStream<Uint8Array>> {
  const { store, adapter, context } = deps;
  const { conversationId } = request;
  const runKey = `${store.scope.workspaceId}:${conversationId}`;

  if (activeRuns.has(runKey)) throw new TurnError(409, "The agent is still working in this conversation.");

  let conversation = await store.getConversation(conversationId);
  let existing: ChatMessage[] = conversation ? await store.listMessages(conversationId) : [];
  // Another server instance may be running this conversation.
  if (existing.at(-1)?.status === "streaming") {
    throw new TurnError(409, "The agent is still working in this conversation.");
  }

  let userMessage: ChatMessage | null = null;
  let prompt: string;

  if (request.kind === "retry") {
    if (!conversation) throw new TurnError(404, "Conversation not found.");
    const lastUser = existing.findLast((m) => m.role === "user");
    if (!lastUser) throw new TurnError(400, "There is no message to retry.");
    prompt = lastUser.content;
    // A message sent with a skill is retried with the skill's current instructions.
    if (lastUser.skill) {
      const skill = await deps.loadSkill?.(lastUser.skill.id);
      if (!skill) throw new TurnError(409, `The skill "${lastUser.skill.name}" was removed from this workspace.`);
      prompt = renderSkillMessage(skill, lastUser.content);
    }
    const last = existing.at(-1);
    // Retry replaces the latest reply, whether it failed or finished.
    if (last?.role === "assistant") {
      await store.deleteMessage(last.id);
      existing = existing.slice(0, -1);
    }
  } else {
    if (!conversation) {
      const title = titleFromMessage(request.skill ? [request.skill.name, request.text.trim()].filter(Boolean).join(" — ") : request.text);
      conversation = await store.createConversation({ id: conversationId, title });
    }
    userMessage = await store.insertMessage({
      id: crypto.randomUUID(),
      conversationId,
      role: "user",
      content: request.text,
      status: "complete",
      activity: [],
      artifacts: [],
      skill: request.skill ? { id: request.skill.id, name: request.skill.name } : null,
    });
    existing = [...existing, userMessage];
    prompt = request.skill ? renderSkillMessage(request.skill, request.text) : request.text;
  }

  // Prior completed turns, excluding the message being answered now.
  const promptIndex = existing.findLastIndex((m) => m.role === "user");
  const history = existing
    .slice(0, promptIndex)
    .filter((m) => m.status === "complete" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));

  const assistant = await store.insertMessage({
    id: crypto.randomUUID(),
    conversationId,
    role: "assistant",
    content: "",
    status: "streaming",
    activity: [],
    artifacts: [],
  });

  const controller = new AbortController();
  activeRuns.set(runKey, controller);

  const threadId = conversation.agentProvider === adapter.id ? conversation.agentThreadId : null;
  const summary: ConversationSummary = {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
  const encoder = new TextEncoder();
  // Whether the browser is still listening. The run continues either way.
  let open = true;

  return new ReadableStream<Uint8Array>({
    async start(stream) {
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
      let saving: Promise<void> = Promise.resolve();
      const checkpoint = () => {
        lastCheckpoint = Date.now();
        saving = saving
          .then(() => store.updateMessage(assistant.id, { content, activity, artifacts }))
          .catch((e) => console.error("[turn] checkpoint failed", e));
      };
      const heartbeat = setInterval(() => {
        if (Date.now() - lastCheckpoint >= (deps.heartbeatMs ?? 15_000)) checkpoint();
      }, Math.min(deps.heartbeatMs ?? 15_000, STALE_STREAM_MS / 4));

      send({ type: "start", conversation: summary, userMessage, assistantMessage: assistant });

      try {
        const events = adapter.run({ conversationId, threadId, message: prompt, history, tenant: context, signal: controller.signal });
        for await (const event of withIdleTimeout(events, deps.idleTimeoutMs, controller.signal)) {
          switch (event.type) {
            case "thread":
              if (event.threadId && event.threadId !== threadId) {
                await store.setAgentThread(conversationId, adapter.id, event.threadId);
              }
              break;
            case "text-delta":
              content += event.text;
              send({ type: "text", delta: event.text });
              break;
            case "message":
              content = event.text;
              send({ type: "text-replace", text: event.text });
              break;
            case "note": {
              const at = Date.now();
              const step: ActivityStep = {
                id: `note:${activity.filter((s) => s.action === "note").length}`,
                label: event.text.slice(0, 300),
                status: "done",
                app: "agent",
                action: "note",
                startedAt: at,
                endedAt: at,
              };
              activity.push(step);
              send({ type: "activity", step });
              break;
            }
            case "activity": {
              const at = Date.now();
              const index = activity.findIndex((s) => s.id === event.id);
              const previous = index >= 0 ? activity[index] : undefined;
              const step: ActivityStep = {
                id: event.id,
                label: event.label,
                status: event.status,
                detail: event.detail,
                app: event.app,
                action: event.action,
                // Keep a receipt once seen, even if a later update omits it.
                preview: event.preview ?? previous?.preview,
                hidden: event.hidden,
                startedAt: previous?.startedAt ?? at,
                endedAt: event.status === "running" ? undefined : previous?.endedAt ?? at,
              };
              if (previous && sameStep(previous, step)) break;
              if (index >= 0) activity[index] = step;
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
          if (Date.now() - lastCheckpoint > (deps.checkpointMs ?? 2000)) checkpoint();
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
        clearInterval(heartbeat);
        if (!controller.signal.aborted) controller.abort();
        activeRuns.delete(runKey);
      }

      await saving;
      let updated = summary;
      try {
        await store.updateMessage(assistant.id, { content, status, activity, artifacts, error });
        updated = await store.touchConversation(conversationId);
      } catch (e) {
        console.error("[turn] failed to save final state", e);
      }
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
      // The browser went away (closed tab, reload, navigation). Keep working; the reply is
      // saved as it progresses and the browser picks it up when it comes back.
      open = false;
    },
  });
}

function sameStep(a: ActivityStep, b: ActivityStep): boolean {
  return (
    a.status === b.status &&
    a.label === b.label &&
    a.detail === b.detail &&
    a.app === b.app &&
    a.hidden === b.hidden &&
    JSON.stringify(a.preview) === JSON.stringify(b.preview)
  );
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
        timer = setTimeout(() => reject(new AgentError("The agent stopped responding. Try again in a moment.")), ms);
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

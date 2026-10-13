import { z } from "zod";
import { AgentError, type AgentAdapter, type AgentAttachment, type AgentResume, type AgentTenantContext } from "@/lib/agent/types";
import { STALE_STREAM_MS, type StoredApproval, type StoredAttachment, type Store } from "@/lib/db/store";
import { renderSkillMessage } from "@/lib/skills/render";
import {
  ARTIFACT_KINDS,
  MAX_MEMORY_LENGTH,
  type ActivityStep,
  type Approval,
  type Artifact,
  type ChatMessage,
  type ConversationSummary,
  type MemoryProposal,
  type MessageStatus,
  type StreamEvent,
} from "@/lib/types";

// Runs one conversational turn for one tenant: persists the user's message, drives the
// agent adapter with the tenant's context, streams normalized events to the browser, and
// persists the assistant's final state however the run ends (finished, failed, timed out,
// stopped, or paused for an approval). A decision on an approval continues the same reply.
// The store is already scoped to the caller's workspace and user.

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

export type TurnRequest = { conversationId: string } & (
  | { kind: "send"; text: string; skill?: TurnSkill; attachmentIds?: string[] }
  | { kind: "retry" }
  /** Replace the latest member message and answer it again (keeping its skill and files). */
  | { kind: "edit"; messageId: string; text: string }
  /** Answer the conversation's pending approval and let the agent continue. */
  | { kind: "decide"; approvalId: string; decision: "approve" | "reject" }
);

export interface TurnDeps {
  store: Store;
  adapter: AgentAdapter;
  context: AgentTenantContext;
  idleTimeoutMs: number;
  /** Loads an attachment's bytes for the agent (under the caller's session). */
  loadAttachment?: (attachment: StoredAttachment) => Promise<Blob>;
  /** Loads a skill from the caller's workspace, for retrying or editing a message sent with one. */
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

const MAX_PROPOSALS = 5;

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
  const pending = conversation ? await store.pendingApproval(conversationId) : null;

  let userMessage: ChatMessage | null = null;
  let prompt = "";
  /** The member message being answered, whose files the agent gets. */
  let promptMessageId: string | null = null;
  let resume: AgentResume | undefined;
  /** For a decision: the reply that paused, which this run continues. */
  let continued: ChatMessage | null = null;
  let decided: StoredApproval | null = null;

  if (request.kind === "decide") {
    if (!conversation) throw new TurnError(404, "Conversation not found.");
    if (!pending || pending.id !== request.approvalId) throw new TurnError(409, "This request was already answered.");
    continued = existing.find((m) => m.id === pending.messageId) ?? null;
    if (!continued || existing.at(-1)?.id !== continued.id) throw new TurnError(409, "This request was already answered.");
    if (pending.provider !== adapter.id) {
      await store.settleApproval(pending.id, "pending", "expired");
      throw new TurnError(409, "This request can't be answered anymore. Ask the agent again.");
    }
    const to = request.decision === "approve" ? "approved" : "declined";
    if (!(await store.settleApproval(pending.id, "pending", to))) throw new TurnError(409, "This request was already answered.");
    decided = { ...pending, status: to, decidedAt: Date.now() };
    resume = { decision: request.decision, state: pending.providerState };
  } else if (pending && request.kind === "send") {
    // A new message waits for the pending decision.
    throw new TurnError(409, "Approve or decline the agent's request first.");
  }

  /** Retrying or editing abandons a pending decision, once the request is known to be valid. */
  const abandonPending = async () => {
    if (!pending || request.kind === "decide") return;
    await store.settleApproval(pending.id, "pending", "expired");
    await adapter.discard?.(pending.providerState).catch(() => undefined);
  };
  /** A message sent with a skill is answered with the skill's current instructions. */
  const withSkill = async (message: ChatMessage, text: string) => {
    if (!message.skill) return text;
    const skill = await deps.loadSkill?.(message.skill.id);
    if (!skill) throw new TurnError(409, `The skill "${message.skill.name}" was removed from this workspace.`);
    return renderSkillMessage(skill, text);
  };

  if (request.kind === "retry") {
    if (!conversation) throw new TurnError(404, "Conversation not found.");
    const lastUser = existing.findLast((m) => m.role === "user");
    if (!lastUser) throw new TurnError(400, "There is no message to retry.");
    prompt = await withSkill(lastUser, lastUser.content);
    promptMessageId = lastUser.id;
    await abandonPending();
    const last = existing.at(-1);
    // Retry replaces the latest reply, whether it failed or finished.
    if (last?.role === "assistant") {
      await store.deleteMessage(last.id);
      existing = existing.slice(0, -1);
    }
    await rewind(deps, conversation.agentProvider === adapter.id ? conversation.agentThreadId : null, conversationId);
  } else if (request.kind === "edit") {
    if (!conversation) throw new TurnError(404, "Conversation not found.");
    const lastUser = existing.findLast((m) => m.role === "user");
    if (!lastUser || lastUser.id !== request.messageId) throw new TurnError(409, "Only your latest message can be edited.");
    prompt = await withSkill(lastUser, request.text);
    promptMessageId = lastUser.id;
    await abandonPending();
    await store.updateMessage(lastUser.id, { content: request.text });
    await store.deleteMessagesAfter(conversationId, lastUser.id);
    userMessage = { ...lastUser, content: request.text };
    existing = [...existing.slice(0, existing.indexOf(lastUser)), userMessage];
    await rewind(deps, conversation.agentProvider === adapter.id ? conversation.agentThreadId : null, conversationId);
  } else if (request.kind === "send") {
    const ids = [...new Set(request.attachmentIds ?? [])];
    if (ids.length > 0 && !adapter.capabilities.attachments) throw new TurnError(400, "This agent can't read attached files yet.");
    const created = !conversation;
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
    if (ids.length > 0) {
      if (!(await store.claimAttachments(ids, userMessage.id))) {
        if (created) await store.deleteConversation(conversationId);
        else await store.deleteMessage(userMessage.id);
        throw new TurnError(400, "Some files couldn't be attached. Remove them and attach them again.");
      }
      userMessage = { ...userMessage, attachments: (await store.listAttachments(userMessage.id)).map(publicAttachment) };
    }
    existing = [...existing, userMessage];
    prompt = request.skill ? renderSkillMessage(request.skill, request.text) : request.text;
    promptMessageId = userMessage.id;
  }
  if (!conversation) throw new TurnError(404, "Conversation not found.");

  const attachments: AgentAttachment[] = [];
  if (promptMessageId && !resume) {
    const stored = await store.listAttachments(promptMessageId);
    if (stored.length > 0 && !deps.loadAttachment) throw new TurnError(400, "Attached files can't be read right now.");
    for (const a of stored) attachments.push({ id: a.id, name: a.name, mimeType: a.mimeType, size: a.size, read: () => deps.loadAttachment!(a) });
  }

  // Prior completed turns, excluding the message being answered now.
  const promptIndex = existing.findLastIndex((m) => m.role === "user");
  const history = existing
    .slice(0, promptIndex)
    .filter((m) => m.status === "complete" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));

  let assistant: ChatMessage;
  if (continued) {
    await store.updateMessage(continued.id, { status: "streaming", error: null });
    assistant = {
      ...continued,
      status: "streaming",
      error: null,
      approvals: (continued.approvals ?? []).map((a) => (a.id === decided!.id ? publicApproval(decided!) : a)),
    };
  } else {
    assistant = await store.insertMessage({
      id: crypto.randomUUID(),
      conversationId,
      role: "assistant",
      content: "",
      status: "streaming",
      activity: [],
      artifacts: [],
    });
  }

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

      let content = assistant.content;
      const activity: ActivityStep[] = [...assistant.activity];
      const artifacts: Artifact[] = [...assistant.artifacts];
      const approvals: Approval[] = [...(assistant.approvals ?? [])];
      const proposals: MemoryProposal[] = [...(assistant.memoryProposals ?? [])];
      let status: MessageStatus = "complete";
      let error: string | null = null;
      let paused = false;
      let lastCheckpoint = Date.now();
      let saving: Promise<void> = Promise.resolve();
      const checkpoint = () => {
        lastCheckpoint = Date.now();
        saving = saving
          .then(() => store.updateMessage(assistant.id, { content, activity, artifacts, memoryProposals: proposals }))
          .catch((e) => console.error("[turn] checkpoint failed", e));
      };
      const heartbeat = setInterval(() => {
        if (Date.now() - lastCheckpoint >= (deps.heartbeatMs ?? 15_000)) checkpoint();
      }, Math.min(deps.heartbeatMs ?? 15_000, STALE_STREAM_MS / 4));

      send({ type: "start", conversation: summary, userMessage, assistantMessage: assistant });

      try {
        const events = adapter.run({
          conversationId,
          threadId,
          message: prompt,
          history,
          tenant: context,
          attachments,
          resume,
          signal: controller.signal,
        });
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
            case "memory-proposal": {
              const text = event.content.replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_LENGTH);
              if (!text || proposals.length >= MAX_PROPOSALS || proposals.some((p) => p.content === text)) break;
              const proposal: MemoryProposal = { id: crypto.randomUUID(), content: text, scope: event.scope, status: "pending" };
              proposals.push(proposal);
              send({ type: "memory-proposal", proposal });
              break;
            }
            case "approval": {
              const stored = await store.createApproval({
                conversationId,
                messageId: assistant.id,
                summary: event.summary.slice(0, 500) || "The agent wants to make a change",
                app: event.app?.slice(0, 40),
                details: event.details.slice(0, 8).map(([k, v]) => [k.slice(0, 40), v.slice(0, 300)]),
                provider: adapter.id,
                providerState: event.state,
              });
              const approval = publicApproval(stored);
              approvals.push(approval);
              paused = true;
              send({ type: "approval", approval });
              break;
            }
          }
          if (Date.now() - lastCheckpoint > (deps.checkpointMs ?? 2000)) checkpoint();
        }
        if (paused) {
          status = "awaiting";
        } else if (!content.trim() && artifacts.length === 0 && proposals.length === 0) {
          status = "error";
          error = "The agent finished without a response.";
        }
      } catch (e) {
        if (e instanceof AgentError) {
          status = "error";
          error = e.message;
          if (e.code === "expired" && decided) {
            await store.settleApproval(decided.id, decided.status, "expired").catch(() => undefined);
            const index = approvals.findIndex((a) => a.id === decided!.id);
            if (index >= 0) approvals[index] = { ...approvals[index], status: "expired" };
          }
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
        await store.updateMessage(assistant.id, { content, status, activity, artifacts, memoryProposals: proposals, error });
        updated = await store.touchConversation(conversationId);
      } catch (e) {
        console.error("[turn] failed to save final state", e);
      }
      send({
        type: "end",
        message: { ...assistant, content, status, activity, artifacts, approvals, memoryProposals: proposals, error },
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

/** Drops the latest exchange from the provider's own memory before it is answered again. */
async function rewind(deps: TurnDeps, threadId: string | null, conversationId: string): Promise<void> {
  if (!deps.adapter.capabilities.rewind || !deps.adapter.rewind) return;
  try {
    await deps.adapter.rewind({ tenant: deps.context, conversationId, threadId }, 1);
  } catch (e) {
    // The reply is still answered; the agent may just see the earlier attempt too.
    console.error("[turn] rewind failed", e);
  }
}

function publicApproval(a: StoredApproval | Approval): Approval {
  return { id: a.id, summary: a.summary, app: a.app, details: a.details, status: a.status, createdAt: a.createdAt, decidedAt: a.decidedAt };
}

function publicAttachment(a: StoredAttachment) {
  return { id: a.id, name: a.name, mimeType: a.mimeType, size: a.size };
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

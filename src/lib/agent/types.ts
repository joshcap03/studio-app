import type { ActivityStatus, Artifact, MemoryCategory, StepAction, StepPreview } from "@/lib/types";
import type { Evidence } from "@/lib/agent/tools/evidence";

// The contract between this application and any agent provider (Langflow today; LangGraph,
// Deep Agents, or others later). Adapters translate their provider's protocol into these
// events. Frontend components, conversation storage, and authentication never see which
// provider is running.

/** Who the run is for. Built server-side from the authenticated session, never from input. */
export interface AgentTenantContext {
  workspaceId: string;
  workspaceName: string;
  userId: string;
  /** The person's private id for their connected apps (Composio user id), the same in all their agents. */
  composioUserId: string;
  /** Who the agent is assisting, as they described themself. Shared by all their agents. */
  account?: { name: string; about: string };
  /** Apps offered for connection: toolkit slug → auth config id. Empty when none are configured. */
  composioToolkits: Record<string, string>;
  /** Workspace-configured agent profile: who the agent works for and what it's for. */
  profile: string;
  /** Workspace-configured instructions for the agent. */
  agentInstructions: string;
  /** What memory recalls for this run: workspace and personal facts, most relevant first, size-capped. */
  memories: string[];
  /** The member's task this conversation works on, if any: its brief, what done looks like, and current plan. */
  task?: { title: string; instructions: string; goal?: string | null; plan: { text: string; status: string; note: string | null }[] } | null;
  /**
   * In a conversation that's neither a task's nor the setup interview, the plan the agent keeps
   * for the work in it (update_plan), and what done looks like. Absent while it has none.
   */
  plan?: { goal: string | null; steps: { text: string; status: string; note: string | null }[] } | null;
  /**
   * The member's tracker rows (most recently changed first), so the agent doesn't re-add what
   * it found. Absent when the member has no tracker, so the agent knows not to save to one.
   */
  tracker?: { collection: string; key: string; title: string; status: string | null }[];
  /** Set when this conversation is the agent's setup interview: its checklist so far, and what done looks like. */
  setup?: {
    plan: { text: string; status: string; note?: string | null }[];
    goal?: string | null;
    /**
     * While the interview is under way, how to run it (the setup skill's instructions). Only the
     * first message carries the skill, and a long interview scrolls it out of the agent's view.
     */
    instructions?: string;
  } | null;
  /**
   * Reference rows the template keeps in view in every chat (e.g. interview stories), with
   * their fields, unlike the tracker's one-line summaries.
   */
  notes?: { collection: string; title: string; fields: Record<string, unknown> }[];
  /** Names of the member's files for this agent; they arrive as attachments on every run. */
  agentFiles?: string[];
  /**
   * The member's Library: docs the agent made for them and links they filed (pinned first, then
   * most recent), so it reopens and updates them instead of making new ones.
   */
  library?: { title: string; kind: string; url: string; pinned: boolean }[];
  /**
   * How the member's bar is holding up: what they kept of the results they judged lately, and
   * what they passed on and why. `lastBatch` is the last card they judged, when they passed on
   * most of it, with what they've said in other chats since. Absent until they've judged something.
   */
  bar?: {
    kept: number;
    judged: number;
    days: number;
    passes: { title: string; reason: string | null }[];
    lastBatch?: { judged: number; kept: number; items: { title: string; verdict: "keep" | "pass"; reason: string | null }[]; since: string[] };
  };
  /** The member's project this conversation is in, if any. Its files arrive as attachments. */
  project?: { name: string; instructions: string; files: string[] } | null;
  /**
   * The member's personal guardrail, if they have one: rules that override every other
   * instruction, plus titles of their recent conversations so repeated questions can be noticed.
   */
  guardrail?: { instructions: string; recentChats: string[] } | null;
  /** How the member is talking on this turn, when it isn't typing (see modalityContext in langflow.ts). */
  modality?: "voice_note" | "call";
  /** The member hears a task run's news as a voice note (src/lib/voice/notes.ts), so its report is written for the ear. */
  voiceNotes?: boolean;
  /**
   * The member could talk this through with the agent on a call here, so it may offer one
   * (offer_call): they have calls, aren't on one, and haven't said Not now to an offer here.
   */
  calls?: boolean;
  /**
   * Who the agent is to this member (src/lib/companion.ts): the name they kept (else null) and
   * how it talks with them once one is chosen. `callName` is the starting name calls introduce
   * it by while it has none of its own (voice on); `naming: false` where it can't be given one
   * (companions off). Absent where neither companions nor voice are on.
   */
  self?: { name: string | null; manner: string | null; callName?: string | null; naming?: boolean } | null;
}

/** A file the member attached to the message being answered. */
export interface AgentAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Loads the file (from the member's own storage, under their session). */
  read(): Promise<Blob>;
}

/** Continue a run the provider paused for approval. */
export interface AgentResume {
  decision: "approve" | "reject";
  /** Told to the agent along with a decline. */
  note?: string;
  /** The provider's own state from the `approval` event that paused the run. */
  state: unknown;
}

export interface AgentRunInput {
  /** This app's conversation id. Adapters derive provider thread ids from it plus the tenant. */
  conversationId: string;
  /** The provider's thread id from a previous turn of this conversation, or null. */
  threadId: string | null;
  message: string;
  /** Prior completed turns, oldest first, for providers that don't keep their own history. */
  history: { role: "user" | "assistant"; content: string }[];
  tenant: AgentTenantContext;
  /** Files attached to `message`. Empty for providers without `attachments`. */
  attachments: AgentAttachment[];
  /** Set when this run continues a paused one instead of answering `message` afresh. */
  resume?: AgentResume;
  /** Aborted when the user stops generation or disconnects. Adapters must honor it. */
  signal: AbortSignal;
}

export type AgentEvent =
  /** The provider assigned (or confirmed) the thread id for this conversation. */
  | { type: "thread"; threadId: string }
  /**
   * This run's id in the provider's tracing, when it's verified to be traced under it. The app
   * keeps it with the reply so the member's rating of the reply can be attached to the trace.
   */
  | { type: "trace"; traceId: string }
  /** Incremental assistant text. */
  | { type: "text-delta"; text: string }
  /** The full assistant text at once. Replaces any prior text. */
  | { type: "message"; text: string }
  /** A short line the agent says about what it's about to do (not part of the answer). */
  | { type: "note"; text: string }
  /** A note sent earlier was part of the reply after all; it's streamed again as reply text right after. */
  | { type: "note-reply"; text: string }
  /** A step started, changed, or finished. Re-emit the same id to update it. */
  | {
      type: "activity";
      id: string;
      label: string;
      status: ActivityStatus;
      detail?: string;
      app?: string;
      action?: StepAction;
      preview?: StepPreview;
      hidden?: boolean;
    }
  /** A structured output the provider produced. */
  | { type: "artifact"; artifact: Artifact }
  /**
   * The run paused before an action that needs the member's approval. The adapter ends the
   * run after this event; the app stores `state` and passes it back in `resume`. `actions`:
   * what approving it would run, each with its raw arguments, as the provider will run them
   * (several when one approval covers more than one), for deciding whether it may be approved by
   * voice. Server-side only: never sent or stored. Absent when the adapter can't tell, which
   * keeps it a tap.
   */
  | { type: "approval"; summary: string; app?: string; details: [string, string][]; actions?: ApprovalAction[]; state: unknown }
  /** The agent suggested a fact to remember. Nothing is saved unless the member confirms. */
  | { type: "memory-proposal"; content: string; scope: "workspace" | "personal"; category?: MemoryCategory }
  /** An investigation's timeline, unvalidated; the turn checks it against this run's results. */
  | { type: "timeline"; timeline: unknown }
  /** Sources the agent will cite as [n], unvalidated; the turn checks them against `evidence`. */
  | { type: "citations"; citations: unknown }
  /** Text this run's tools returned for a link. Server-side only: never sent or stored. */
  | { type: "evidence"; items: Evidence[] }
  /** A chart, key numbers, or table an investigation reported, unvalidated. */
  | { type: "visual"; visual: unknown }
  /** Multiple-choice questions for the member, unvalidated; the answer comes as their next message. */
  | { type: "questions"; questions: unknown }
  /** A form or a proposed agent setup to show the member (`{form}` or `{proposal}`), unvalidated. */
  | { type: "ui"; block: unknown }
  /**
   * The plan for the work in this conversation as the agent rewrote it, and what done looks like
   * (absent from flows that don't send one), unvalidated. Saved on the conversation's task, the
   * setup checklist, or the conversation itself (src/lib/journey.ts).
   */
  | { type: "plan-update"; plan: unknown; goal?: unknown }
  /** A tracker row the agent added or updated (upserted by collection and key), unvalidated. */
  | { type: "record"; record: unknown }
  /** A link the agent filed in the member's Library on their request (file_link), unvalidated. */
  | { type: "library-item"; item: unknown }
  /** How a task's run went (nothing new, an update, or needs the member), unvalidated. */
  | { type: "run-report"; report: unknown };

/**
 * One thing approving a request would run: the tool as the provider names it (a Composio slug
 * like GMAIL_SEND_EMAIL, or anything else) and its arguments, unvalidated.
 */
export interface ApprovalAction {
  tool: string;
  arguments: unknown;
}

/** What a provider has been verified to support. The app adapts its behavior to these. */
export interface AgentCapabilities {
  /** Text arrives incrementally. */
  streaming: boolean;
  /** How a run is stopped: "abort" (provider stops on request), "disconnect" (provider stops
   *  when the connection closes; best effort), or "none" (the run continues remotely). */
  cancellation: "abort" | "disconnect" | "none";
  /** The provider reports tool calls / steps. */
  toolEvents: boolean;
  /** The provider can report structured artifacts. */
  artifacts: boolean;
  /** Runs can be polled for status after the fact (getRunStatus). */
  runStatus: boolean;
  /** Runs can pause for approval and continue (approval events, `resume`). */
  approvals: boolean;
  /** The agent can read files attached to a message. */
  attachments: boolean;
  /** The provider's own conversation memory can be rolled back (rewind) and erased (forget). */
  rewind: boolean;
}

export interface AgentAdapter {
  readonly id: string;
  readonly label: string;
  /** True only for a real provider. The UI labels every mock response. */
  readonly live: boolean;
  readonly capabilities: AgentCapabilities;
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
  /** Present only when capabilities.runStatus is true. */
  getRunStatus?(threadId: string): Promise<"running" | "complete" | "failed" | "unknown">;
  /**
   * Present only when capabilities.rewind is true. Drops the latest `turns` exchanges (a
   * member message and everything after it) from the provider's own memory of the
   * conversation, so a retried or edited message isn't answered with the old one in view.
   */
  rewind?(input: { tenant: AgentTenantContext; conversationId: string; threadId: string | null }, turns: number): Promise<void>;
  /**
   * Present only when capabilities.rewind is true. Erases the provider's own memory of a
   * conversation the member deleted.
   */
  forget?(input: { tenant: Pick<AgentTenantContext, "workspaceId" | "composioUserId">; conversationId: string }): Promise<void>;
  /** Abandons a paused run whose approval will never be answered (best effort). */
  discard?(state: unknown): Promise<void>;
}

/** A failure whose message is safe to show to the user. */
export class AgentError extends Error {
  readonly retryable: boolean;
  /** "expired": a paused run can no longer be continued. */
  readonly code?: "expired";
  constructor(message: string, options: { retryable?: boolean; cause?: unknown; code?: "expired" } = {}) {
    super(message, { cause: options.cause });
    this.name = "AgentError";
    this.retryable = options.retryable ?? true;
    this.code = options.code;
  }
}

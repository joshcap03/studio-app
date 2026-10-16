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
  /** This member's private id for their connected apps (Composio user id). */
  composioUserId: string;
  /** Apps offered for connection: toolkit slug → auth config id. Empty when none are configured. */
  composioToolkits: Record<string, string>;
  /** Workspace-configured description of the business. */
  businessContext: string;
  /** Workspace-configured instructions for the agent. */
  agentInstructions: string;
  /** What memory recalls for this run: workspace and personal facts, most relevant first, size-capped. */
  memories: string[];
  /** The member's project this conversation is in, if any. Its files arrive as attachments. */
  project?: { name: string; instructions: string; files: string[] } | null;
  /**
   * The member's personal guardrail, if they have one: rules that override every other
   * instruction, plus titles of their recent conversations so repeated questions can be noticed.
   */
  guardrail?: { instructions: string; recentChats: string[] } | null;
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
  /** Incremental assistant text. */
  | { type: "text-delta"; text: string }
  /** The full assistant text at once. Replaces any prior text. */
  | { type: "message"; text: string }
  /** A short line the agent says about what it's about to do (not part of the answer). */
  | { type: "note"; text: string }
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
   * run after this event; the app stores `state` and passes it back in `resume`.
   */
  | { type: "approval"; summary: string; app?: string; details: [string, string][]; state: unknown }
  /** The agent suggested a fact to remember. Nothing is saved unless the member confirms. */
  | { type: "memory-proposal"; content: string; scope: "workspace" | "personal"; category?: MemoryCategory }
  /** An investigation's timeline, unvalidated; the turn checks it against this run's results. */
  | { type: "timeline"; timeline: unknown }
  /** Sources the agent will cite as [n], unvalidated; the turn checks them against `evidence`. */
  | { type: "citations"; citations: unknown }
  /** Text this run's tools returned for a link. Server-side only: never sent or stored. */
  | { type: "evidence"; items: Evidence[] }
  /** Multiple-choice questions for the member, unvalidated; the answer comes as their next message. */
  | { type: "questions"; questions: unknown };

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
  /** The provider's own conversation memory can be rolled back (rewind). */
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

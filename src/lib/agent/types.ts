import type { ActivityStatus, Artifact, StepAction, StepPreview } from "@/lib/types";

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
  /** Workspace-configured description of the business. */
  businessContext: string;
  /** Workspace-configured instructions for the agent. */
  agentInstructions: string;
  /** Workspace memory plus this member's personal memory, newest first, size-capped. */
  memories: string[];
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
  | { type: "artifact"; artifact: Artifact };

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
}

/** A failure whose message is safe to show to the user. */
export class AgentError extends Error {
  readonly retryable: boolean;
  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "AgentError";
    this.retryable = options.retryable ?? true;
  }
}

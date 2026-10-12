import type { ActivityStatus, Artifact } from "@/lib/types";

// The contract between this application and any agent backend. Adapters translate their
// backend's wire protocol into these events; nothing outside src/lib/agent knows which
// backend is running.

export interface AgentRunInput {
  /** The backend's own thread/conversation id from a previous turn, or null for a new thread. */
  threadId: string | null;
  /** The user's new message. */
  message: string;
  /** Prior completed turns, oldest first, for backends that don't keep their own memory. */
  history: { role: "user" | "assistant"; content: string }[];
  /** Aborted when the user stops generation or disconnects. Adapters must honor it. */
  signal: AbortSignal;
}

export type AgentEvent =
  /** The backend assigned (or confirmed) the thread id for this conversation. */
  | { type: "thread"; threadId: string }
  /** Incremental assistant text (streaming backends). */
  | { type: "text-delta"; text: string }
  /** The full assistant text at once (non-streaming backends). Replaces any prior text. */
  | { type: "message"; text: string }
  /** A step started, changed, or finished. Re-emit the same id to update it. */
  | { type: "activity"; id: string; label: string; status: ActivityStatus; detail?: string }
  /** A structured output the backend produced. */
  | { type: "artifact"; artifact: Artifact };

export interface AgentAdapter {
  readonly id: string;
  /** True only for a real backend. The UI labels every mock response. */
  readonly live: boolean;
  readonly label: string;
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
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

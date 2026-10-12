// Shared domain types. Imported by the browser and the server, so this file must stay
// free of runtime dependencies on either side.

export type MessageRole = "user" | "assistant";

/**
 * - `streaming`   the agent is still producing this message
 * - `complete`    finished normally
 * - `stopped`     the user stopped generation; content is partial
 * - `error`       the agent failed; `error` holds a user-safe explanation
 * - `interrupted` a run was cut off (server restart, closed tab) before it finished
 */
export type MessageStatus = "streaming" | "complete" | "stopped" | "error" | "interrupted";

export type ActivityStatus = "running" | "done" | "failed";

/** One observable step of agent execution, as reported by the agent backend. */
export interface ActivityStep {
  id: string;
  label: string;
  status: ActivityStatus;
  detail?: string;
  startedAt: number;
  endedAt?: number;
}

export const ARTIFACT_KINDS = [
  "spreadsheet",
  "document",
  "presentation",
  "pdf",
  "image",
  "data",
  "file",
  "link",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** A durable output the agent produced, described by structured backend metadata. */
export interface Artifact {
  id: string;
  kind: ArtifactKind;
  title: string;
  /** Short human-readable context, e.g. "629 rows · 4 columns". */
  description?: string;
  /** Where the file lives, e.g. "Google Sheets". */
  source?: string;
  /** https URL to open the artifact. */
  url?: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  activity: ActivityStep[];
  artifacts: Artifact[];
  error?: string | null;
  createdAt: number;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentStatus {
  mode: "mock" | "live";
  label: string;
}

/** Events the application server streams to the browser (NDJSON, one per line). */
export type StreamEvent =
  | {
      type: "start";
      conversation: ConversationSummary;
      userMessage: ChatMessage | null;
      assistantMessage: ChatMessage;
    }
  | { type: "text"; delta: string }
  | { type: "text-replace"; text: string }
  | { type: "activity"; step: ActivityStep }
  | { type: "artifact"; artifact: Artifact }
  | { type: "end"; message: ChatMessage; conversation: ConversationSummary };

export const MAX_MESSAGE_LENGTH = 32_000;
export const MAX_TITLE_LENGTH = 120;

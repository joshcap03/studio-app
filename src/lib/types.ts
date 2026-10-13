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

export type StepAction = "search" | "read" | "write" | "run" | "remember" | "browse" | "connect" | "other";

/**
 * What a step actually did, built from the tool call's real input and output. Size-capped
 * and sanitized on the server before it is stored or sent.
 */
export type StepPreview =
  | { type: "sources"; items: { title: string; url: string; domain: string }[]; total?: number }
  | { type: "items"; items: { primary: string; secondary?: string; url?: string }[]; total?: number }
  | { type: "table"; columns: string[]; rows: string[][]; total?: number; title?: string }
  | {
      type: "code";
      language: string;
      code: string;
      output?: string;
      /** Progress the code reported with explicit "STEP …" lines, in order. */
      steps?: string[];
    }
  | { type: "text"; text: string }
  | { type: "link"; url: string; title?: string };

/** One observable step of agent execution, as reported by the agent backend. */
export interface ActivityStep {
  id: string;
  label: string;
  status: ActivityStatus;
  detail?: string;
  /** The app the step worked in (see src/lib/apps.ts). */
  app?: string;
  action?: StepAction;
  preview?: StepPreview;
  /** Internal plumbing (tool discovery, schema lookups): counted, not listed. */
  hidden?: boolean;
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
  /** "unavailable": a live agent is configured but not enabled for this workspace. */
  mode: "mock" | "live" | "unavailable";
  label: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: "owner" | "member";
}

export interface WorkspaceSettings {
  name: string;
  businessContext: string;
  agentInstructions: string;
}

export interface Memory {
  id: string;
  content: string;
  /** "workspace": shared business memory. "personal": visible only to its owner. */
  scope: "workspace" | "personal";
  createdAt: number;
  mine: boolean;
}

export interface ToolkitConnection {
  slug: string;
  name: string;
  description?: string;
  status: "connected" | "pending" | "disconnected";
  connectionId?: string;
}

export interface ConnectionsState {
  configured: boolean;
  toolkits: ToolkitConnection[];
}

export interface UsageSummary {
  runsToday: number;
  runsPerDayLimit: number;
  runsPerMinuteLimit: number;
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
export const MAX_MEMORY_LENGTH = 2000;
export const MAX_CONTEXT_LENGTH = 8000;

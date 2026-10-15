// Shared domain types. Imported by the browser and the server, so this file must stay
// free of runtime dependencies on either side.

export type MessageRole = "user" | "assistant";

/**
 * - `streaming`   the agent is still producing this message
 * - `complete`    finished normally
 * - `stopped`     the user stopped generation; content is partial
 * - `error`       the agent failed; `error` holds a user-safe explanation
 * - `interrupted` a run was cut off (server restart, closed tab) before it finished
 * - `awaiting`    the agent paused until the member approves or declines an action
 */
export type MessageStatus = "streaming" | "complete" | "stopped" | "error" | "interrupted" | "awaiting";

export type ActivityStatus = "running" | "done" | "failed";

export type StepAction = "search" | "read" | "write" | "run" | "remember" | "browse" | "connect" | "note" | "other";

/**
 * What a step actually did, built from the tool call's real input and output. Size-capped
 * and sanitized on the server before it is stored or sent.
 */
export type StepPreview =
  | { type: "sources"; items: { title: string; url: string; domain: string }[]; total?: number }
  | { type: "items"; items: { primary: string; secondary?: string; url?: string }[]; total?: number; query?: string }
  | { type: "table"; columns: string[]; rows: string[][]; total?: number; title?: string }
  | {
      type: "code";
      language: string;
      code: string;
      output?: string;
      /** Progress the code reported with explicit "STEP …" lines, in order. */
      steps?: string[];
    }
  /** query: what the tool was asked, when it was a search or question. */
  | { type: "text"; text: string; query?: string }
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

/**
 * An action the agent asked permission for, as reported by the agent backend. It runs only
 * if the member approves it.
 */
export interface Approval {
  id: string;
  /** The agent's one-sentence description of what it will do. */
  summary: string;
  /** The app it would act in (see src/lib/apps.ts). */
  app?: string;
  /** Key arguments, e.g. [["To", "jo@acme.com"], ["Subject", "March invoice"]]. */
  details: [string, string][];
  status: "pending" | "approved" | "declined" | "expired";
  createdAt: number;
  decidedAt?: number;
}

/**
 * A fact the agent chose to remember while replying. Normally saved right away ("saved",
 * with the memory's id so the member can undo it); "pending" when saving failed and the
 * member can save it themselves; "dismissed" once undone or declined.
 */
export interface MemoryProposal {
  id: string;
  content: string;
  scope: "workspace" | "personal";
  status: "pending" | "saved" | "dismissed";
  memoryId?: string;
  category?: MemoryCategory;
}

/** How Business Brain groups facts. The agent picks one when it saves; members can change it. */
export const MEMORY_CATEGORIES = [
  "customers",
  "suppliers",
  "products",
  "policies",
  "voice",
  "team",
  "other",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  customers: "Customers",
  suppliers: "Suppliers",
  products: "Products & pricing",
  policies: "Policies & rules",
  voice: "Voice & style",
  team: "Team",
  other: "Other",
};

export function toMemoryCategory(value: unknown): MemoryCategory {
  return typeof value === "string" && (MEMORY_CATEGORIES as readonly string[]).includes(value) ? (value as MemoryCategory) : "other";
}

/** A file the member attached to a message. */
export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  activity: ActivityStep[];
  artifacts: Artifact[];
  /** Approvals the agent asked for while writing this reply, oldest first. */
  approvals?: Approval[];
  memoryProposals?: MemoryProposal[];
  attachments?: Attachment[];
  error?: string | null;
  /** User messages only: the skill attached to it, if any. */
  skill?: MessageSkill | null;
  /** A "why?" investigation's timeline, as the agent reported it (see Timeline). */
  timeline?: Timeline | null;
  /** Multiple-choice questions the agent asked at the end of this reply. */
  questions?: Question[] | null;
  createdAt: number;
}

export interface ConversationSummary {
  id: string;
  title: string;
  /** The project it belongs to, if any. */
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A member's folder of related conversations. Its instructions and files reach the agent on
 * every run in one of its conversations. Private to the member who made it.
 */
export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface Project extends ProjectSummary {
  instructions: string;
  files: Attachment[];
}

export const MAX_PROJECT_NAME_LENGTH = 80;
export const MAX_PROJECT_FILES = 10;
export const MAX_PROJECTS = 100;

export interface AgentStatus {
  /** "unavailable": a live agent is configured but not enabled for this workspace. */
  mode: "mock" | "live" | "unavailable";
  label: string;
  /** Whether the agent can read files attached to a message. */
  attachments: boolean;
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
  category: MemoryCategory;
  /** Pinned facts always reach the agent, ahead of anything recalled by relevance. */
  pinned: boolean;
  /** The message the agent saved this from. Absent for facts added by hand. */
  source?: { conversationId: string; messageId: string };
}

export interface ToolkitConnection {
  slug: string;
  name: string;
  description?: string;
  /** Composio's logo for the app (https). */
  logo?: string;
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
  | { type: "approval"; approval: Approval }
  | { type: "memory-proposal"; proposal: MemoryProposal }
  | { type: "timeline"; timeline: Timeline }
  | { type: "questions"; questions: Question[] }
  | { type: "end"; message: ChatMessage; conversation: ConversationSummary };

export const MAX_MESSAGE_LENGTH = 32_000;
export const MAX_TITLE_LENGTH = 120;
export const MAX_MEMORY_LENGTH = 2000;
export const MAX_CONTEXT_LENGTH = 8000;

/** Files a message can carry. The agent reads text and documents; images go to vision models. */
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  yaml: "application/yaml",
  yml: "application/yaml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};
/**
 * A named set of instructions for a task, added to a workspace from the library or written
 * by the owner. It reaches the agent only on a message it is attached to.
 */
export interface WorkspaceSkill {
  id: string;
  /** The library entry it was added from, if any. */
  catalogId: string | null;
  name: string;
  description: string;
  instructions: string;
  createdAt: number;
}

/** The skill a user message was sent with. */
export interface MessageSkill {
  id: string;
  name: string;
}

export const MAX_SKILL_NAME_LENGTH = 80;
export const MAX_SKILL_DESCRIPTION_LENGTH = 200;
export const MAX_SKILL_INSTRUCTIONS_LENGTH = 4000;
export const MAX_SKILLS = 50;

/** A member's request to share one of their personal memories with the whole workspace. */
export interface MemoryPromotion {
  id: string;
  /** The personal memory it came from (`personal:<doc>`); only meaningful to the requester. */
  memoryId: string;
  content: string;
  category: MemoryCategory;
  status: "pending" | "approved" | "rejected";
  /** True when the caller asked for it. */
  mine: boolean;
  createdAt: number;
}

/** One dated event a "why?" investigation found while reading the member's apps. */
export interface TimelineEntry {
  /** When it happened, as the source record says (ISO date or date-time preferred). */
  when: string;
  what: string;
  /** The app the record lives in (see src/lib/apps.ts). */
  app?: string;
  /** The record itself. Only kept when this run's tool results actually showed that link. */
  url?: string;
  /** False when the agent cited a link no tool result in this run returned. */
  verified: boolean;
}

/** A "why?" investigation's findings: dated events across apps and the likely causes. */
export interface Timeline {
  question: string;
  /** Oldest first. */
  entries: TimelineEntry[];
  /** Most likely first; `entries` are indexes into the list above. */
  causes: { text: string; entries: number[] }[];
}

export const MAX_TIMELINE_ENTRIES = 40;
export const MAX_TIMELINE_CAUSES = 5;

/**
 * A question the agent asked the member, with choices to click. Answering sends the picked
 * labels as the member's next message; the member can also type their own answer instead.
 */
export interface Question {
  question: string;
  /** A short label for the question, e.g. "Tone". */
  header?: string;
  options: { label: string; description?: string }[];
  /** More than one option can be picked. */
  multiSelect: boolean;
}

export const MAX_QUESTIONS = 3;
export const MAX_QUESTION_OPTIONS = 4;

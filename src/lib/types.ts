// Shared domain types. Imported by the browser and the server, so this file must stay
// free of runtime dependencies on either side.

import type { VoiceKey } from "@/lib/voice/voices";

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

/** Items one member's Library holds per agent; the agent_artifacts migration checks it too. */
export const MAX_LIBRARY_ITEMS = 500;

/** Something filed in the member's Library: an artifact the agent made, or a link they added. */
export interface LibraryItem {
  id: string;
  kind: ArtifactKind;
  title: string;
  url: string;
  description: string | null;
  source: string | null;
  addedBy: "agent" | "member";
  pinned: boolean;
  /** The chat it last came from, if that chat still exists. */
  conversationId: string | null;
  createdAt: number;
  updatedAt: number;
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

/** How the Brain groups facts. The agent picks one when it saves; members can change it. */
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
  // Stored keys predate generic workspaces; only the labels changed.
  customers: "People & contacts",
  suppliers: "Organizations",
  products: "Work & offerings",
  policies: "Rules & preferences",
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

/**
 * How a task's run went, as the agent reported it: whether there's anything for the member.
 * Decides whether the member is notified when the run ends.
 */
export const RUN_OUTCOMES = ["nothing_new", "update", "needs_you"] as const;
export interface RunReport {
  outcome: (typeof RUN_OUTCOMES)[number];
  summary: string;
}

/**
 * Where a message came from when the member didn't type it: a task's run, or their spoken words,
 * on a call (plain "voice", as rows from before voice messages say) or held as a voice message
 * (`via: "note"`).
 */
export type MessageOrigin =
  | {
      kind: "task";
      taskId: string;
      /** The task's title when the run started, for a "Scheduled · …" label. */
      title: string;
      runId: string | null;
    }
  | { kind: "voice"; via?: "note" };

/** The most a voice note says: about forty seconds. */
export const MAX_VOICE_NOTE_CHARS = 600;

/**
 * A reply the member can hear as well as read (src/lib/voice/notes.ts): the words the agent's
 * voice says when they tap play, from the reply itself or from a task run's report. Only the
 * words are kept; the audio is made on each play and never stored.
 */
export interface VoiceNote {
  script: string;
  source: "reply" | "summary";
}

/**
 * How the member is talking to the agent on this turn: typing, a held voice message, or a live
 * call (where a voice front speaks for the agent and shows its cards).
 */
export const MODALITIES = ["text", "voice_note", "call"] as const;
export type Modality = (typeof MODALITIES)[number];

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
  /** User messages only: set when no one typed it, e.g. a task's run. */
  origin?: MessageOrigin | null;
  /** An investigation's timeline, as the agent reported it (see Timeline). */
  timeline?: Timeline | null;
  /** Sources the reply cites as [n], checked against this run's tool results. */
  citations?: Citation[] | null;
  /** Multiple-choice questions the agent asked at the end of this reply. */
  questions?: Question[] | null;
  /** Forms and proposals the agent put under this reply, and what the member did with each. */
  ui?: UiBlock[] | null;
  uiResponse?: Record<string, UiResponse> | null;
  /** Assistant messages only: the member's thumbs up or down on this reply, and why. */
  feedback?: MessageFeedback | null;
  /** Assistant messages only: what the agent's voice says about this reply, when it has a voice note. */
  voiceNote?: VoiceNote | null;
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
/** Files on a member's shelf for one agent, sent with every run of that agent. */
export const MAX_AGENT_FILES = 10;
/** Standing files (agent files, then project files) one run carries, besides the message's own. */
export const MAX_RUN_FILES = 15;

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

/**
 * Where an agent is in getting to know one member (src/lib/companion.ts): a sketch, drawn in
 * with use, ready once it knows them, and arrived once they keep the name it suggests.
 */
export type CompanionStage = "sketch" | "drawn" | "ready" | "arrived";

/** How one agent looks to one member, fixed from their ids so it never changes. */
export interface CompanionLook {
  shape: "classic" | "tall" | "wide" | "cushion";
  tint: "chart-1" | "chart-2" | "chart-3" | "chart-4";
  /** Spreads idle motion (blinks) across marks so they never move in step. */
  seed: number;
}

export interface Companion {
  workspaceId: string;
  stage: CompanionStage;
  /** Its own name, once it has arrived. */
  name: string | null;
  /** How it talks with the member, in its own words, once one is chosen (at any stage). */
  manner: string | null;
  /** The voice the member chose for it (src/lib/voice/voices.ts); null keeps its template's. */
  voice: VoiceKey | null;
  look: CompanionLook;
}

export interface WorkspaceSettings {
  name: string;
  /** What this agent is for: who it works for and what they want from it. */
  profile: string;
  agentInstructions: string;
  /** The built-in template (src/lib/templates) the workspace started from or last applied. */
  templateId: string | null;
  /** Where the owner is in the agent's setup interview; null until it's started. */
  setup: AgentSetup | null;
}

/** What the chat screen shows the owner about the agent's setup: how far along, and where. */
export interface SetupSummary {
  status: "not_started" | AgentSetup["status"];
  conversationId: string | null;
  done: number;
  total: number;
  /** The checklist as the agent last reported it, or the template's steps before it has. */
  plan: JourneyStep[];
}

/**
 * One step of a journey the agent reports with update_plan (a setup checklist, a task's plan):
 * `note` is what finishing it gave the agent, or what's in the way.
 */
export interface JourneyStep {
  text: string;
  status: "todo" | "doing" | "done" | "blocked" | "needs_you";
  note?: string | null;
}

/** The setup interview's state (see src/lib/skills/setup.ts). */
export interface AgentSetup {
  status: "in_progress" | "done" | "skipped";
  /** The conversation the interview runs in. */
  conversationId: string | null;
  /** The checklist as the agent last reported it (update_plan), with each step's status and outcome. */
  plan: JourneyStep[];
  updatedAt: number;
}

export interface Memory {
  id: string;
  content: string;
  /** "workspace": shared workspace memory. "personal": visible only to its owner. */
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
  | { type: "citations"; citations: Citation[] }
  | { type: "questions"; questions: Question[] }
  | { type: "ui"; ui: UiBlock[] }
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

/**
 * A numbered source the agent cited in its answer as [n]. Only kept when this run's tools
 * returned that link; `quoteVerified` says whether the quoted passage was found in what the
 * tool returned for it.
 */
export interface Citation {
  n: number;
  url: string;
  quote: string;
  quoteVerified: boolean;
  title?: string;
  app?: string;
}

export const MAX_CITATIONS = 30;

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

/** An investigation's findings: dated events across apps and the likely causes. */
export interface Timeline {
  question: string;
  /** Oldest first. */
  entries: TimelineEntry[];
  /** Most likely first; `entries` are indexes into the list above. */
  causes: { text: string; entries: number[] }[];
  /** Charts, key numbers, and tables the agent drew from what it read, in reported order. */
  visuals?: Visual[];
}

/** One graphic an investigation reported through report_visual (see src/lib/chat/visuals.ts). */
export type Visual = { title: string; app?: string } & (
  | {
      kind: "chart";
      chart: "bar" | "line";
      unit: string;
      labels: string[];
      /** One value per label; null where the agent had no number. */
      series: { name: string; values: (number | null)[] }[];
    }
  | { kind: "stats"; items: { label: string; value: string; change?: string; tone?: "good" | "bad" | "neutral" }[] }
  | { kind: "table"; columns: string[]; rows: string[][] }
);

export const MAX_VISUALS = 6;

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

/**
 * Cards the agent puts under a reply for the member to act on (see src/lib/chat/ui.ts): a form
 * to fill in, whose answers go out as the member's next message, or a proposed setup for the
 * agent, which changes nothing until the member applies it.
 */
export type UiBlock = UiForm | AgentProposal | MemoryMergeProposal;

export interface UiOption {
  label: string;
  description?: string;
}

interface FieldBase {
  /** Unique within the form, e.g. "roles". */
  id: string;
  label: string;
  help?: string;
  required: boolean;
}

/** One sub-field of a list entry, e.g. a STAR story's "Result". */
export interface UiListPart {
  id: string;
  label: string;
  /** A paragraph rather than a line. */
  long: boolean;
}

/** One result the member judges in a verdict field, e.g. a role the agent found. */
export interface UiVerdictItem {
  id: string;
  title: string;
  body?: string;
  /** An http(s) link to the thing itself. */
  link?: string;
  /** The tracker row it is, so a verdict can be tied back to it. */
  record?: { collection: string; key: string };
}

/** The member's call on one verdict item. */
export type Verdict = "keep" | "pass";

export type UiField = FieldBase &
  (
    /** `allowOther`: a "Something else" tile that takes the member's own words. */
    | { kind: "choice" | "multi_choice"; options: UiOption[]; prefill?: string[]; allowOther?: boolean }
    /** Options the member puts in order, most important first; `prefill` is the agent's order. */
    | { kind: "rank"; options: UiOption[]; prefill?: string[] }
    /** A point on a 1..steps scale between two labelled ends. */
    | { kind: "scale"; steps: number; low: string; high: string; prefill?: number }
    /** Results the member keeps or passes on, a pass with a reason (from `reasons`, or their own). */
    | { kind: "verdict"; items: UiVerdictItem[]; reasons: string[] }
    | { kind: "text" | "long_text"; placeholder?: string; prefill?: string }
    /** Files the member drops in; `accept` holds extensions from ATTACHMENT_TYPES; `keep` puts them on the agent's shelf. */
    | { kind: "file"; accept: string[]; max: number; keep: boolean }
    /** Repeatable entries with the same parts, e.g. stories; `prefill` holds the agent's drafts. */
    | { kind: "list"; parts: UiListPart[]; itemLabel: string; max: number; prefill?: Record<string, string>[] }
    /** Apps to connect, shown as Connect buttons. */
    | { kind: "connect"; apps: string[] }
  );

export interface UiForm {
  kind: "form";
  id: string;
  title: string;
  intro?: string;
  fields: UiField[];
  submitLabel: string;
}

/** A recurring task schedule, as src/lib/tasks/schedule.ts defines it. */
export type UiSchedule =
  | { every: "day" | "weekdays"; at: string }
  | { every: "week"; at: string; weekday: number }
  | { every: "hours"; hours: number };

export interface ProposedTask {
  /** The template task it switches on, when it's one of those. */
  templateTaskId?: string;
  title: string;
  instructions: string;
  /** A library skill id the task runs with. */
  skill?: string;
  schedule: UiSchedule | null;
}

export type ProposedSkill = { catalogId: string } | { name: string; description: string; instructions: string };

/** The agent's suggested setup for itself, from what the member told it. */
export interface AgentProposal {
  kind: "proposal";
  id: string;
  summary: string;
  profile?: string;
  instructions?: string;
  skills: ProposedSkill[];
  tasks: ProposedTask[];
  memories: string[];
  /**
   * Who the agent suggests it is to the member, once it knows them: a name (theirs to keep or
   * change) and, in its own words, how it talks with them.
   */
  identity?: { name: string; manner: string };
  /**
   * Ways it could sound with the member, side by side and none marked as its pick: a voice from
   * Studio's catalog and, in its own words, how it would talk. The member chooses one or none.
   */
  sound?: ProposedSound[];
}

export interface ProposedSound {
  voice: VoiceKey;
  manner: string;
}

/** One proposed merge: facts that overlap, and the one fact that would replace them. */
export interface MemoryMerge {
  text: string;
  category: MemoryCategory;
  /** The scope every original shares, and the merged fact's. */
  scope: Memory["scope"];
  /** Whether the merged fact would be pinned (any original is). */
  pinned: boolean;
  /** The facts it replaces, as memory held them when the agent proposed it. */
  originals: { id: string; content: string; pinned: boolean }[];
}

/**
 * The agent's suggestion to combine overlapping facts it remembers into fewer ones (its
 * merge_memories tool). Nothing changes until the member merges them, and a merge can be undone.
 */
export interface MemoryMergeProposal {
  kind: "memory-merge";
  id: string;
  summary: string;
  merges: MemoryMerge[];
}

/** A fact a merge replaced, with everything needed to save it again on Undo. */
export interface MergedOriginal {
  /** Its id before the merge (gone since). */
  id: string;
  content: string;
  scope: Memory["scope"];
  category: MemoryCategory;
  pinned: boolean;
  source?: Memory["source"];
  createdBy: string;
  savedAt: number;
}

/** A merge that took effect, with what it replaced so it can be undone. */
export interface AppliedMerge {
  /** Its place in the proposal. */
  index: number;
  /** The merged fact's id. */
  memoryId: string;
  /** The text saved, with the member's edits. */
  text: string;
  originals: MergedOriginal[];
}

/** Which parts of a proposal the member chose to apply, by item. */
export interface ProposalPicks {
  profile: boolean;
  instructions: boolean;
  skills: number[];
  tasks: number[];
  memories: number[];
  identity?: boolean;
  /** The sound option they chose, by its place in the proposal; none when absent. */
  sound?: number;
}

/** What the member did with one card, keyed by its id in ChatMessage.uiResponse. */
export type UiResponse =
  | { status: "submitted"; at: number }
  | {
      status: "applied";
      at: number;
      /** What took effect, which can be less than the member picked. */
      picks: ProposalPicks;
      /**
       * `skipped`: picked items that couldn't be applied (not the owner, a preview off, memory not
       * set up). `manner`: how it talks with them after this, when its name or sound was applied
       * (absent from cards applied before it was reported).
       */
      applied: { settings: boolean; skills: number; tasks: number; memories: number; skipped: number; name?: string; voice?: VoiceKey; manner?: string | null };
      /** The tasks it switched on or created, in the proposal's order, so the first can run right away. */
      taskIds?: string[];
    }
  /** `skipped`: picked merges that couldn't be made (a fact gone or changed since, or not the member's to change). */
  | { status: "merged"; at: number; merges: AppliedMerge[]; skipped: number }
  /**
   * `skipped`: merges left as they are because the merged fact was edited or removed since;
   * `merges`: the ones that had been made, as the card showed them.
   */
  | { status: "undone"; at: number; restored: number; skipped: number; merges: Pick<AppliedMerge, "index" | "text">[] };

export const MAX_UI_BLOCKS = 2;
export const MAX_FORM_FIELDS = 8;
export const MAX_LIST_ITEMS = 8;
export const MAX_LIST_PARTS = 5;
export const MAX_FORM_FILES = 5;
export const MAX_PROPOSED_ITEMS = 8;
/** Ways to sound a proposal offers side by side. */
export const MAX_SOUND_OPTIONS = 3;
export const MAX_VERDICT_ITEMS = 8;
export const MAX_VERDICT_REASONS = 6;

/** A member's rating of one reply. Reasons come from FEEDBACK_REASONS for that rating. */
export interface MessageFeedback {
  rating: "up" | "down";
  reasons: string[];
  /** What else they said, in their words. */
  note?: string;
}

export const FEEDBACK_REASONS = {
  up: ["Accurate", "Saved me time", "Clear", "Did what I asked"],
  down: ["Wrong or made up", "Didn't do what I asked", "Too long", "Missed context", "Too slow"],
} as const satisfies Record<MessageFeedback["rating"], readonly string[]>;

export const MAX_FEEDBACK_NOTE_LENGTH = 1000;

export const MAX_QUESTIONS = 3;
export const MAX_QUESTION_OPTIONS = 4;

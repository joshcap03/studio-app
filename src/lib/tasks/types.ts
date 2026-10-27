import type { StandingKind } from "@/lib/approvals/standing";
import type { TaskSchedule } from "./schedule";
import type { RUN_STATUSES, STEP_STATUSES, TASK_STATUSES } from "./schema";

// What the app works with for tasks, runs, and records. Times are epoch milliseconds.

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type StepStatus = (typeof STEP_STATUSES)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface PlanStep {
  id: string;
  text: string;
  status: StepStatus;
  note?: string | null;
}

export interface AgentTask {
  id: string;
  title: string;
  instructions: string;
  skillId: string | null;
  schedule: TaskSchedule | null;
  timezone: string;
  status: TaskStatus;
  plan: PlanStep[];
  /** What done looks like, in one line ("Done means …"): the agent's words, or the member's edit. */
  goal: string | null;
  conversationId: string | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  templateTaskId: string | null;
  /**
   * Kinds of change the member has OK'd for good on this task, so its runs don't ask for them
   * again (src/lib/approvals/standing.ts). Given with a tap on a real request, taken back here.
   */
  allowedActions: StandingKind[];
  /** When its plan last changed; null on a task saved before this was kept (updatedAt stands in). */
  planUpdatedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskRun {
  id: string;
  taskId: string;
  scheduledFor: number;
  status: RunStatus;
  reason: string | null;
  messageId: string | null;
  cancelRequestedAt: number | null;
  /** What started a watch's run (docs/watches.md), oldest first; null for any other run. */
  events: WatchEvent[] | null;
  /** Events that arrived after the run held its 20. */
  moreEvents: number;
  /** When a watch's run starts: it waits a little for more events, or for its conversation. */
  notBefore: number | null;
  createdAt: number;
  updatedAt: number;
}

/** One thing that happened in a connected app, as a watch's run carries it. */
export interface WatchEvent {
  /** The provider's id for this delivery. */
  id: string;
  /** When it arrived, as an ISO time. */
  at: string;
  /** One line, e.g. "New email from Dana Lee: Intro call?". */
  summary: string;
  /** The event's own fields, capped; written by whoever sent it, not the member. */
  data: Record<string, unknown>;
}

export type WatchStatus = "watching" | "paused" | "broken";
export type WatchProblem = "disconnected" | "refused" | "removed";

/** What a task watches for: one trigger in one of the member's connected apps. */
export interface TaskWatch {
  id: string;
  taskId: string;
  /** The app, e.g. gmail. */
  toolkit: string;
  /** The provider's trigger, e.g. GMAIL_NEW_GMAIL_MESSAGE. */
  trigger: string;
  /** The trigger's own settings (its filter), as the member set them. */
  config: Record<string, unknown>;
  status: WatchStatus;
  problem: WatchProblem | null;
  lastEventAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** One tracker collection at a glance, for the Library: how many rows, in which statuses. */
export interface TrackerSummary {
  collection: string;
  count: number;
  /** Rows per status, most common first; rows without one are left out. */
  statuses: { status: string; count: number }[];
  updatedAt: number;
}

/** One row of the agent's tracker, e.g. a job application keyed by its URL. */
export interface AgentRecord {
  id: string;
  collection: string;
  key: string;
  title: string;
  status: string | null;
  url: string | null;
  fields: Record<string, unknown>;
  taskId: string | null;
  sourceMessageId: string | null;
  createdAt: number;
  updatedAt: number;
}

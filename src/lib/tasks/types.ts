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

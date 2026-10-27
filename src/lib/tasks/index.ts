import { isStandingKind, type StandingKind } from "@/lib/approvals/standing";
import type { Tenant } from "@/lib/tenant-core";
import { check, fail, time } from "./db";
import { nextRun, type TaskSchedule } from "./schedule";
import { appendRunInput, MAX_TASKS, type AppendRunInput, type TaskDraft, type TaskPatch } from "./schema";
import type { AgentTask, PlanStep, TaskRun } from "./types";

// A member's long-horizon tasks and their runs. Private to the member, like their
// conversations: every query goes through the tenant's RLS-bound client, filtered by the
// tenant's workspace and user, and the database enforces the same.

interface TaskRow {
  id: string;
  title: string;
  instructions: string;
  skill_id: string | null;
  schedule: AgentTask["schedule"];
  timezone: string;
  status: AgentTask["status"];
  plan: PlanStep[];
  goal: string | null;
  conversation_id: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  template_task_id: string | null;
  allowed_actions?: string[] | null;
  plan_updated_at?: string | null;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  task_id: string;
  scheduled_for: string;
  status: TaskRun["status"];
  reason: string | null;
  message_id: string | null;
  cancel_requested_at: string | null;
  events: TaskRun["events"];
  more_events: number;
  not_before: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  "id, title, instructions, skill_id, schedule, timezone, status, plan, goal, conversation_id, next_run_at, last_run_at, template_task_id, allowed_actions, plan_updated_at, created_at, updated_at";
const RUN_COLUMNS = "id, task_id, scheduled_for, status, reason, message_id, cancel_requested_at, events, more_events, not_before, created_at, updated_at";
const MISSING_LINK = "That skill or conversation doesn't exist.";

const toTask = (r: TaskRow): AgentTask => ({
  id: r.id,
  title: r.title,
  instructions: r.instructions,
  skillId: r.skill_id,
  schedule: r.schedule,
  timezone: r.timezone,
  status: r.status,
  plan: r.plan,
  goal: r.goal ?? null,
  conversationId: r.conversation_id,
  nextRunAt: time(r.next_run_at),
  lastRunAt: time(r.last_run_at),
  templateTaskId: r.template_task_id,
  allowedActions: (r.allowed_actions ?? []).filter(isStandingKind),
  planUpdatedAt: time(r.plan_updated_at ?? null),
  createdAt: Date.parse(r.created_at),
  updatedAt: Date.parse(r.updated_at),
});

const toRun = (r: RunRow): TaskRun => ({
  id: r.id,
  taskId: r.task_id,
  scheduledFor: Date.parse(r.scheduled_for),
  status: r.status,
  reason: r.reason,
  messageId: r.message_id,
  cancelRequestedAt: time(r.cancel_requested_at),
  events: r.events ?? null,
  moreEvents: r.more_events ?? 0,
  notBefore: time(r.not_before),
  createdAt: Date.parse(r.created_at),
  updatedAt: Date.parse(r.updated_at),
});

const tasks = (tenant: Tenant) => tenant.db.from("agent_tasks");
const runs = (tenant: Tenant) => tenant.db.from("agent_task_runs");

export async function listTasks(tenant: Tenant): Promise<AgentTask[]> {
  const rows = check(
    await tasks(tenant)
      .select(COLUMNS)
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId)
      .order("updated_at", { ascending: false })
      .limit(MAX_TASKS),
  ) as TaskRow[];
  return rows.map(toTask);
}

export async function getTask(tenant: Tenant, id: string): Promise<AgentTask | null> {
  const row = check(
    await tasks(tenant).select(COLUMNS).eq("id", id).eq("workspace_id", tenant.workspace.id).eq("user_id", tenant.userId).maybeSingle(),
  ) as TaskRow | null;
  return row ? toTask(row) : null;
}

/** The member's task this conversation belongs to, if any. */
export async function getTaskForConversation(tenant: Tenant, conversationId: string): Promise<AgentTask | null> {
  const row = check(
    await tasks(tenant)
      .select(COLUMNS)
      .eq("conversation_id", conversationId)
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ) as TaskRow | null;
  return row ? toTask(row) : null;
}

/** When an active, scheduled task should next run; null if it only runs on demand. */
function nextRunAt(schedule: TaskSchedule | null, timezone: string, status: AgentTask["status"]): string | null {
  return schedule && status === "active" ? nextRun(schedule, timezone, new Date()).toISOString() : null;
}

/** Creates a task, active unless `status` says otherwise (a template's tasks start paused). */
export async function createTask(
  tenant: Tenant,
  draft: TaskDraft & { templateTaskId?: string | null; status?: "active" | "paused" },
): Promise<AgentTask> {
  const status = draft.status ?? "active";
  const { count, error } = await tasks(tenant)
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", tenant.workspace.id)
    .eq("user_id", tenant.userId);
  if (error) throw new Error(error.message);
  if ((count ?? 0) >= MAX_TASKS) fail(409, `You can have up to ${MAX_TASKS} tasks. Delete some first.`);
  const result = await tasks(tenant)
    .insert({
      workspace_id: tenant.workspace.id,
      user_id: tenant.userId,
      title: draft.title,
      instructions: draft.instructions,
      skill_id: draft.skillId,
      schedule: draft.schedule,
      timezone: draft.timezone,
      plan: draft.plan,
      conversation_id: draft.conversationId,
      status,
      next_run_at: nextRunAt(draft.schedule, draft.timezone, status),
      template_task_id: draft.templateTaskId ?? null,
    })
    .select(COLUMNS)
    .single();
  if (result.error?.code === "23505") fail(409, "That task is already set up.");
  return toTask(check(result, MISSING_LINK) as TaskRow);
}

export async function updateTask(tenant: Tenant, id: string, patch: TaskPatch): Promise<AgentTask | null> {
  const now = new Date().toISOString();
  const row: Record<string, unknown> = { updated_at: now };
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.instructions !== undefined) row.instructions = patch.instructions;
  if (patch.skillId !== undefined) row.skill_id = patch.skillId;
  if (patch.schedule !== undefined) row.schedule = patch.schedule;
  if (patch.timezone !== undefined) row.timezone = patch.timezone;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.plan !== undefined) Object.assign(row, { plan: patch.plan, plan_updated_at: now });
  if (patch.goal !== undefined) row.goal = patch.goal;
  if (patch.conversationId !== undefined) row.conversation_id = patch.conversationId;
  // A new schedule, zone, or status moves the next run; anything else leaves it alone.
  if (patch.schedule !== undefined || patch.timezone !== undefined || patch.status !== undefined) {
    const current = await getTask(tenant, id);
    if (!current) return null;
    row.next_run_at = nextRunAt(
      patch.schedule !== undefined ? patch.schedule : current.schedule,
      patch.timezone ?? current.timezone,
      patch.status ?? current.status,
    );
  }
  const rows = check(
    await tasks(tenant)
      .update(row)
      .eq("id", id)
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId)
      .select(COLUMNS),
    MISSING_LINK,
  ) as TaskRow[];
  return rows[0] ? toTask(rows[0]) : null;
}

/**
 * Gives (or, with `allowed` false, takes back) the member's standing OK on one of their tasks for
 * one kind of change (src/lib/approvals/standing.ts). Given only from their tap on a request of
 * that kind in the task's conversation; taken back on the task's page. Null if the task is gone.
 */
export async function setTaskAllowed(tenant: Tenant, id: string, kind: StandingKind, allowed: boolean): Promise<AgentTask | null> {
  const current = await getTask(tenant, id);
  if (!current) return null;
  const next = allowed ? [...new Set([...current.allowedActions, kind])] : current.allowedActions.filter((k) => k !== kind);
  if (next.length === current.allowedActions.length && next.every((k) => current.allowedActions.includes(k))) return current;
  const rows = check(
    await tasks(tenant)
      .update({ allowed_actions: next, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId)
      .select(COLUMNS),
  ) as TaskRow[];
  return rows[0] ? toTask(rows[0]) : null;
}

export async function deleteTask(tenant: Tenant, id: string): Promise<boolean> {
  const rows = check(
    await tasks(tenant).delete().eq("id", id).eq("workspace_id", tenant.workspace.id).eq("user_id", tenant.userId).select("id"),
  ) as { id: string }[];
  return rows.length > 0;
}

/**
 * Records a run of a task for one scheduled time. Returns null if that time already has a
 * run, so a scheduler that retries can't start the same run twice.
 */
export async function appendRun(tenant: Tenant, taskId: string, input: AppendRunInput): Promise<TaskRun | null> {
  const run = appendRunInput.parse(input);
  const result = await runs(tenant)
    .insert({
      task_id: taskId,
      workspace_id: tenant.workspace.id,
      user_id: tenant.userId,
      scheduled_for: run.scheduledFor.toISOString(),
      status: run.status,
      reason: run.reason,
      message_id: run.messageId,
    })
    .select(RUN_COLUMNS)
    .single();
  if (result.error?.code === "23505") return null;
  return toRun(check(result, "That task or message doesn't exist.") as RunRow);
}

export async function listRuns(tenant: Tenant, taskId: string, limit = 50): Promise<TaskRun[]> {
  const rows = check(
    await runs(tenant)
      .select(RUN_COLUMNS)
      .eq("task_id", taskId)
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId)
      .order("scheduled_for", { ascending: false })
      .limit(limit),
  ) as RunRow[];
  return rows.map(toRun);
}

/** Records how a run ended (or where it is), and the reply it wrote. */
export async function settleRun(
  tenant: Tenant,
  runId: string,
  outcome: { status: TaskRun["status"]; reason?: string | null; messageId?: string | null },
): Promise<void> {
  check(
    await runs(tenant)
      .update({
        status: outcome.status,
        reason: outcome.reason ?? null,
        ...(outcome.messageId !== undefined ? { message_id: outcome.messageId } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId)
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId),
    "That reply doesn't exist.",
  );
}

/**
 * Where a run is once its reply's final state is saved: done, still going (its next reply carries
 * the job on: keep_going), still waiting on the member's approval, or failed.
 */
export function runOutcome(
  message: { status: string; keepGoing?: string },
  report?: { outcome?: string | null } | null,
): { status: TaskRun["status"]; reason: string | null } {
  // A reply carries the job on when it says so: finished, or cut off by the request's time limit.
  return (message.status === "complete" || message.status === "error") && message.keepGoing
    ? { status: "running", reason: KEEP_GOING }
    : message.status === "complete"
    ? { status: "done", reason: report?.outcome ?? null }
    : message.status === "awaiting"
      ? { status: "running", reason: "waiting_on_you" }
      : { status: "failed", reason: message.status };
}

/**
 * Records where a task's run is once the member answered the request it waited on and the reply
 * it continues ends: the run that wrote that reply and was waiting on them. Nothing else changes.
 */
export async function settleWaitingRun(
  tenant: Tenant,
  taskId: string,
  message: { id: string; status: string },
  report?: { outcome?: string | null } | null,
): Promise<void> {
  const outcome = runOutcome(message, report);
  check(
    await runs(tenant)
      .update({ ...outcome, updated_at: new Date().toISOString() })
      .eq("task_id", taskId)
      .eq("message_id", message.id)
      .eq("status", "running")
      .eq("reason", "waiting_on_you")
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId),
  );
}

/** A run whose reply ran out of time with more to do, which its next reply carries on. */
export const KEEP_GOING = "keep_going";
/** A run whose next reply has been claimed to carry it on. */
const CONTINUING = "continuing";

/** Takes a run waiting to carry on for its next reply, once. False if it isn't waiting (or someone else took it). */
export async function claimKeptRun(tenant: Tenant, runId: string): Promise<boolean> {
  const rows = check(
    await runs(tenant)
      .update({ reason: CONTINUING, updated_at: new Date().toISOString() })
      .eq("id", runId)
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId)
      .eq("status", "running")
      .eq("reason", KEEP_GOING)
      .select("id"),
  ) as { id: string }[];
  return rows.length > 0;
}

/**
 * Records where a task's run is once a reply that carried it on from the member's page ends: the
 * run that was waiting to carry on (or had been taken to), with that reply as its latest.
 */
export async function settleKeptRun(
  tenant: Tenant,
  taskId: string,
  message: { id: string; status: string; keepGoing?: string },
  report?: { outcome?: string | null } | null,
): Promise<void> {
  check(
    await runs(tenant)
      .update({ ...runOutcome(message, report), message_id: message.id, updated_at: new Date().toISOString() })
      .eq("task_id", taskId)
      .eq("status", "running")
      .in("reason", [KEEP_GOING, CONTINUING])
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId),
  );
}

/** Stamps when a task last ran. */
export async function markTaskRan(tenant: Tenant, taskId: string, at = new Date()): Promise<void> {
  check(
    await tasks(tenant)
      .update({ last_run_at: at.toISOString(), updated_at: at.toISOString() })
      .eq("id", taskId)
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId),
  );
}

export async function getRun(tenant: Tenant, runId: string): Promise<TaskRun | null> {
  const row = check(
    await runs(tenant)
      .select(RUN_COLUMNS)
      .eq("id", runId)
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId)
      .maybeSingle(),
  ) as RunRow | null;
  return row ? toRun(row) : null;
}

/** Moves a queued run to running. False when it was already started (or isn't queued). */
export async function beginRun(tenant: Tenant, runId: string): Promise<boolean> {
  const rows = check(
    await runs(tenant)
      .update({ status: "running", updated_at: new Date().toISOString() })
      .eq("id", runId)
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId)
      .eq("status", "queued")
      .select("id"),
  ) as { id: string }[];
  return rows.length > 0;
}

/** Moves a queued watch run's start to `at` (its conversation was busy). False once it started. */
export async function deferRun(tenant: Tenant, runId: string, at: Date): Promise<boolean> {
  const rows = check(
    await runs(tenant)
      .update({ not_before: at.toISOString(), updated_at: new Date().toISOString() })
      .eq("id", runId)
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId)
      .eq("status", "queued")
      .select("id"),
  ) as { id: string }[];
  return rows.length > 0;
}

/** Whether the member asked to stop this run (from any device or server). */
export async function runStopRequested(tenant: Tenant, runId: string): Promise<boolean> {
  return (await getRun(tenant, runId))?.cancelRequestedAt != null;
}

/**
 * Asks the run in progress in a task's conversation to stop, wherever it's running: the
 * process running it sees the request on its next heartbeat. Does nothing for a conversation
 * that isn't a task's.
 */
export async function requestStop(tenant: Tenant, conversationId: string): Promise<void> {
  const task = await getTaskForConversation(tenant, conversationId);
  if (!task) return;
  const now = new Date().toISOString();
  check(
    await runs(tenant)
      .update({ cancel_requested_at: now, updated_at: now })
      .eq("task_id", task.id)
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId)
      .eq("status", "running")
      .is("cancel_requested_at", null),
  );
}

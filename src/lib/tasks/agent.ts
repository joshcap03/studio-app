import type { AgentTenantContext } from "@/lib/agent/types";
import { storeFor } from "@/lib/chat/store-for";
import { conversationJourney, setupJourney, taskJourney } from "@/lib/journey";
import { getSetup, setupHolds, updateSetup } from "@/lib/setup-state";
import type { Tenant } from "@/lib/tenant-core";
import { MAX_GOAL_LENGTH, type Journey } from "@/lib/types";
import { getTaskForConversation, updateTask } from "./index";
import { fieldsByCollection, withoutBlanks } from "./fields";
import { listRecords, upsertRecord } from "./records";
import { repeats } from "./schedule";
import { MAX_PLAN_STEPS, planSchema, STEP_STATUSES, upsertRecordInput } from "./schema";
import type { AgentTask, PlanStep } from "./types";

// The agent's side of tasks and plans: what it's told about the conversation's task (or its own
// plan for the work here) and the member's tracker before a run, and checking what it reports
// back (update_plan, save_record) before it's saved under the member's own session. Nothing the
// agent sends picks the task, the member, or the workspace; those come from the session and the
// conversation.

/** How much of the tracker the agent sees: the most recently touched rows. */
const TRACKER_ROWS = 150;

const contextSteps = (plan: PlanStep[]) => plan.map(({ text, status, note }) => ({ text, status, note: note ?? null }));

/**
 * The task this conversation belongs to (or, in any other conversation, the plan the agent keeps
 * for the work in it) and the member's tracker, for the agent's context. `preloaded`: the task
 * as the caller already read it (null for none), so it isn't read again.
 */
export async function taskContextFor(
  tenant: Tenant,
  conversationId: string | undefined,
  preloaded?: Promise<AgentTask | null>,
): Promise<Pick<AgentTenantContext, "task" | "plan" | "tracker" | "trackerFields">> {
  const [task, records, own] = await Promise.all([
    preloaded ?? (conversationId ? getTaskForConversation(tenant, conversationId) : Promise.resolve(null)),
    listRecords(tenant),
    // Without its own plan the run still has its task and tracker.
    conversationId
      ? storeFor(tenant)
          .getPlan(conversationId)
          .catch((e) => {
            console.error("[context] couldn't load the conversation's plan", e);
            return null;
          })
      : Promise.resolve(null),
  ]);
  return {
    task: task
      ? {
          title: task.title,
          instructions: task.instructions,
          goal: task.goal,
          plan: repeats(task) ? [] : contextSteps(task.plan),
          ...(repeats(task) ? { repeats: true } : {}),
        }
      : null,
    plan: !task && own?.steps.length ? { goal: own.goal, steps: contextSteps(own.steps) } : null,
    tracker: records.slice(0, TRACKER_ROWS).map((r) => ({ collection: r.collection, key: r.key, title: r.title, status: r.status })),
    trackerFields: fieldsByCollection(records),
  };
}

const str = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * What done looks like, as the agent gave it with its plan (update_plan's goal), or null when it
 * gave none. Taken only from that argument, never from the reply's text.
 */
export function goalFromAgent(value: unknown): string | null {
  // It's shown after "Done means", so a goal that says it again doesn't say it twice.
  return str(typeof value === "string" ? value.replace(/^\s*done means\b[\s:,-]*/i, "") : value, MAX_GOAL_LENGTH) || null;
}

/**
 * The goal to keep with the setup's or a conversation's rewritten plan: the one the agent gave,
 * else the current one while the work carries on (some step is unchanged, or there were no steps
 * to compare). A plan with nothing in common with the last is new work, so the old goal goes with
 * the old plan rather than titling it. A task's goal is the task's, so it doesn't come here: it
 * stays until the agent gives a new one or the member changes it.
 */
export function goalFor(given: string | null, steps: { text: string }[], previous: { text: string }[], current: string | null | undefined): string | null {
  if (given) return given;
  if (!previous.length) return current ?? null;
  return steps.some((s) => previous.some((p) => p.text === s.text)) ? (current ?? null) : null;
}

/**
 * The agent's rewritten plan as stored steps, or null if it isn't one. Step ids are assigned
 * here by position; unknown statuses read as todo.
 */
export function planFromAgent(value: unknown, previous: PlanStep[] = []): PlanStep[] | null {
  if (!Array.isArray(value)) return null;
  const steps = value
    .slice(0, MAX_PLAN_STEPS)
    .map((raw, i): PlanStep | null => {
      const step = typeof raw === "string" ? { text: raw } : raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
      const text = step ? str(step.text, 200) : "";
      if (!text) return null;
      const status = (STEP_STATUSES as readonly string[]).includes(step!.status as string) ? (step!.status as PlanStep["status"]) : "todo";
      const note = str(step!.note, 300) || null;
      // Keep a step's id when its text is unchanged, so edits the member made stay attached.
      const id = previous.find((p) => p.text === text)?.id ?? `s${i + 1}`;
      return { id, text, status, note };
    })
    .filter((s): s is PlanStep => s !== null);
  const unique = steps.map((s, i) => (steps.findIndex((o) => o.id === s.id) === i ? s : { ...s, id: `s${i + 1}-${i}` }));
  const parsed = planSchema.safeParse(unique);
  return parsed.success ? parsed.data : null;
}

/**
 * Saves the agent's plan, and what done looks like, where the work in this conversation keeps it
 * (src/lib/journey.ts): on the conversation's task, in the owner's setup checklist while their
 * setup interview is under way here, or else on the conversation itself (so work after setup is
 * applied or set aside never writes over its checklist). `setup`: the run was started with the
 * setup skill, so its plan is the setup's even before the conversation is recorded as the
 * setup's. Returns the journey as saved, or null when nothing was (no plan in it, no such
 * conversation, or a task that repeats, which keeps none).
 */
export async function savePlanFromAgent(
  tenant: Tenant,
  conversationId: string,
  value: unknown,
  rawGoal?: unknown,
  { setup: setupRun = false }: { setup?: boolean } = {},
): Promise<Journey | null> {
  const given = goalFromAgent(rawGoal);
  const owner = tenant.workspace.role === "owner";
  const [task, setup] = await Promise.all([
    setupRun ? Promise.resolve(null) : getTaskForConversation(tenant, conversationId),
    owner ? getSetup(tenant) : Promise.resolve(null),
  ]);
  if (task) {
    if (repeats(task)) return null;
    const plan = planFromAgent(value, task.plan);
    if (!plan) return null;
    // The member may have said what done means on the task page, before any plan or since: a
    // plan saved without a goal keeps it, however different its steps.
    const saved = await updateTask(tenant, task.id, { plan, ...(given ? { goal: given } : {}) });
    return saved ? taskJourney(saved) : null;
  }
  if (owner && (setupRun || setupHolds(setup, conversationId))) {
    const plan = planFromAgent(value);
    if (!plan) return null;
    const steps = plan.map(({ text, status, note }) => ({ text, status, ...(note ? { note } : {}) }));
    // A setup started over in a new conversation doesn't carry the old one's goal.
    const before = setup?.conversationId === conversationId ? setup : null;
    const goal = goalFor(given, steps, before?.plan ?? [], before?.goal);
    if (!(await updateSetup(tenant, { plan: steps, goal, ...(setupRun ? { conversationId } : {}) }))) return null;
    return setupJourney({ plan: steps, goal, updatedAt: Date.now() });
  }
  const store = storeFor(tenant);
  const own = await store.getPlan(conversationId);
  if (!own) return null;
  const plan = planFromAgent(value, own.steps);
  if (!plan) return null;
  const saved = await store.savePlan(conversationId, { steps: plan, goal: goalFor(given, plan, own.steps, own.goal) });
  return saved ? conversationJourney(saved) : null;
}

/**
 * Upserts a tracker row the agent reported, linked to the conversation's task (if any) and
 * the reply that reported it. Resolves with the row's collection, or null when it doesn't validate.
 */
export async function saveRecordFromAgent(
  tenant: Tenant,
  conversationId: string,
  value: unknown,
  source: { messageId: string },
): Promise<string | null> {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const task = await getTaskForConversation(tenant, conversationId);
  const parsed = upsertRecordInput.safeParse({
    collection: str(raw.collection, 40).toLowerCase(),
    key: str(raw.key, 200),
    ...(str(raw.title, 200) ? { title: str(raw.title, 200) } : {}),
    ...(str(raw.status, 40) ? { status: str(raw.status, 40) } : {}),
    ...(str(raw.url, 2000) ? { url: str(raw.url, 2000) } : {}),
    // A placeholder the agent wrote ("next_step": "None") is no detail, so it isn't kept.
    ...(raw.fields && typeof raw.fields === "object" && !Array.isArray(raw.fields) ? { fields: withoutBlanks(raw.fields as Record<string, unknown>) } : {}),
    taskId: task?.id ?? null,
    sourceMessageId: source.messageId,
  });
  if (!parsed.success) return null;
  await upsertRecord(tenant, parsed.data);
  return parsed.data.collection;
}

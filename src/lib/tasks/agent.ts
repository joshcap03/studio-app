import type { AgentTenantContext } from "@/lib/agent/types";
import { isSetupConversation, updateSetup } from "@/lib/setup-state";
import type { Tenant } from "@/lib/tenant-core";
import { getTaskForConversation, updateTask } from "./index";
import { listRecords, upsertRecord } from "./records";
import { MAX_PLAN_STEPS, planSchema, STEP_STATUSES, upsertRecordInput } from "./schema";
import type { PlanStep } from "./types";

// The agent's side of tasks: what it's told about the conversation's task and the member's
// tracker before a run, and checking what it reports back (update_plan, save_record) before
// it's saved under the member's own session. Nothing the agent sends picks the task, the
// member, or the workspace; those come from the session and the conversation.

/** How much of the tracker the agent sees: the most recently touched rows. */
const TRACKER_ROWS = 150;

/** The task this conversation belongs to and the member's tracker, for the agent's context. */
export async function taskContextFor(
  tenant: Tenant,
  conversationId: string | undefined,
): Promise<Pick<AgentTenantContext, "task" | "tracker">> {
  const [task, records] = await Promise.all([
    conversationId ? getTaskForConversation(tenant, conversationId) : Promise.resolve(null),
    listRecords(tenant),
  ]);
  return {
    task: task ? { title: task.title, instructions: task.instructions, plan: task.plan.map(({ text, status, note }) => ({ text, status, note: note ?? null })) } : null,
    tracker: records.slice(0, TRACKER_ROWS).map((r) => ({ collection: r.collection, key: r.key, title: r.title, status: r.status })),
  };
}

const str = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

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
 * Saves the agent's plan to the conversation's task, or to the setup checklist when this is
 * the agent's setup conversation. False when it's neither, or there's no plan.
 */
export async function savePlanFromAgent(tenant: Tenant, conversationId: string, value: unknown): Promise<boolean> {
  const task = await getTaskForConversation(tenant, conversationId);
  if (!task) {
    if (!(await isSetupConversation(tenant, conversationId))) return false;
    const plan = planFromAgent(value);
    return plan ? updateSetup(tenant, { plan: plan.map(({ text, status }) => ({ text, status })) }) : false;
  }
  const plan = planFromAgent(value, task.plan);
  if (!plan) return false;
  return (await updateTask(tenant, task.id, { plan })) !== null;
}

/**
 * Upserts a tracker row the agent reported, linked to the conversation's task (if any) and
 * the reply that reported it. False when the row doesn't validate.
 */
export async function saveRecordFromAgent(
  tenant: Tenant,
  conversationId: string,
  value: unknown,
  source: { messageId: string },
): Promise<boolean> {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  const task = await getTaskForConversation(tenant, conversationId);
  const parsed = upsertRecordInput.safeParse({
    collection: str(raw.collection, 40).toLowerCase(),
    key: str(raw.key, 200),
    ...(str(raw.title, 200) ? { title: str(raw.title, 200) } : {}),
    ...(str(raw.status, 40) ? { status: str(raw.status, 40) } : {}),
    ...(str(raw.url, 2000) ? { url: str(raw.url, 2000) } : {}),
    ...(raw.fields && typeof raw.fields === "object" && !Array.isArray(raw.fields) ? { fields: raw.fields } : {}),
    taskId: task?.id ?? null,
    sourceMessageId: source.messageId,
  });
  if (!parsed.success) return false;
  await upsertRecord(tenant, parsed.data);
  return true;
}

import { storeFor } from "@/lib/chat/store-for";
import type { ConversationPlan } from "@/lib/db/store";
import { getSetup, setupHolds, toTheBar } from "@/lib/setup-state";
import { getTaskForConversation } from "@/lib/tasks";
import type { AgentTask, PlanStep } from "@/lib/tasks/types";
import type { Tenant } from "@/lib/tenant-core";
import type { AgentSetup, Journey, JourneyStep } from "@/lib/types";

// Where a conversation's plan lives, and how the member sees it: the plan of the task the
// conversation works on, else the setup interview's checklist while the owner's interview is
// under way in it, else the conversation's own plan (any other work with several steps, including
// work after the setup is applied or set aside). Each is the agent's update_plan as saved under
// the member's session, with what done looks like.

const toStep = ({ text, status, note }: PlanStep | JourneyStep): JourneyStep => ({ text, status, ...(note ? { note } : {}) });

/** A task's plan as a journey; null while it has no steps. */
export function taskJourney(task: Pick<AgentTask, "plan" | "goal" | "updatedAt"> & { planUpdatedAt?: number | null }): Journey | null {
  return task.plan.length ? { kind: "task", goal: task.goal, steps: task.plan.map(toStep), updatedAt: task.planUpdatedAt ?? task.updatedAt } : null;
}

/**
 * The setup checklist as a journey, shown as far as the member's bar until they've confirmed it
 * (toTheBar), as the setup banner shows it; null while the agent hasn't written one.
 */
export function setupJourney(setup: Pick<AgentSetup, "plan" | "goal" | "updatedAt">): Journey | null {
  return setup.plan.length ? { kind: "setup", goal: setup.goal ?? null, steps: toTheBar(setup.plan).map(toStep), updatedAt: setup.updatedAt } : null;
}

/** A conversation's own plan as a journey; null while it has no steps. */
export function conversationJourney(plan: ConversationPlan): Journey | null {
  return plan.steps.length ? { kind: "conversation", goal: plan.goal, steps: plan.steps.map(toStep), updatedAt: plan.updatedAt ?? Date.now() } : null;
}

/** The journey of the work in this conversation, or null when the agent keeps no plan for it. */
export async function journeyFor(tenant: Tenant, conversationId: string): Promise<Journey | null> {
  const [task, setup, own] = await Promise.all([
    getTaskForConversation(tenant, conversationId),
    // Only the owner's setup counts, and only the owner can read it.
    tenant.workspace.role === "owner" ? getSetup(tenant) : Promise.resolve(null),
    storeFor(tenant).getPlan(conversationId),
  ]);
  if (task) return taskJourney(task);
  if (setup && setupHolds(setup, conversationId)) return setupJourney(setup);
  return own ? conversationJourney(own) : null;
}

/** journeyFor, or null when it can't be read: the conversation still loads without its rail. */
export function journeyOrNone(tenant: Tenant, conversationId: string): Promise<Journey | null> {
  return journeyFor(tenant, conversationId).catch((error) => {
    console.error("[journey] couldn't read the plan", error);
    return null;
  });
}

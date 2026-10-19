import { DISCOVERY_STEP, SUCCESS_STEP, templateById } from "@/lib/templates";
import type { Tenant } from "@/lib/tenant-core";
import type { AgentSetup, SetupSummary } from "@/lib/types";

// Where the owner is in the agent's setup interview (workspace_settings.setup): started, its
// conversation, the checklist the agent keeps with update_plan, and done once they apply the
// proposed setup. Only the owner's setup counts, and the database lets only owners write it.

function check<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

export async function getSetup(tenant: Tenant): Promise<AgentSetup | null> {
  const row = check(
    await tenant.db.from("workspace_settings").select("setup").eq("workspace_id", tenant.workspace.id).maybeSingle(),
  ) as { setup: AgentSetup | null } | null;
  return row?.setup ?? null;
}

/** Merges `patch` into the setup state. False when the caller isn't the owner (nothing saved). */
export async function updateSetup(tenant: Tenant, patch: Partial<Omit<AgentSetup, "updatedAt">>): Promise<boolean> {
  if (tenant.workspace.role !== "owner") return false;
  const current = await getSetup(tenant);
  const setup: AgentSetup = {
    status: patch.status ?? current?.status ?? "in_progress",
    conversationId: patch.conversationId !== undefined ? patch.conversationId : (current?.conversationId ?? null),
    plan: patch.plan ?? current?.plan ?? [],
    updatedAt: Date.now(),
  };
  check(await tenant.db.from("workspace_settings").update({ setup, updated_at: new Date().toISOString() }).eq("workspace_id", tenant.workspace.id));
  return true;
}

/**
 * What the owner sees of the setup: its checklist as the agent last reported it, or, before it
 * has, the two steps every setup opens with (what they're after, then their bar), all still to do.
 * The agent adds the rest only once it knows their problem needs them, never the whole template.
 * Null for anyone but the owner.
 */
export function summarizeSetup(tenant: Tenant, setup: AgentSetup | null, templateId: string | null): SetupSummary | null {
  if (tenant.workspace.role !== "owner") return null;
  const opening = templateById(templateId) ? [DISCOVERY_STEP, SUCCESS_STEP].map((s) => ({ text: s.title, status: "todo" as const })) : [];
  const plan = setup?.plan.length ? toTheBar(setup.plan) : opening;
  return {
    status: setup?.status ?? "not_started",
    conversationId: setup?.conversationId ?? null,
    done: plan.filter((s) => s.status === "done").length,
    total: plan.length,
    plan,
  };
}

/** The step that agrees their bar, and the steps a fair trial of it needs before then. */
const BAR = /success|\bbar\b|judg/i;
const ON_THE_WAY = /trial|résumé|resume/i;

/**
 * The checklist as far as the member's bar until they've confirmed it: steps after it that are
 * still to do (anything but a trial or what one needs) stay off until then, even if the agent
 * listed them, as a checklist from before setup grew step by step did. Finished steps always show.
 */
export function toTheBar(plan: AgentSetup["plan"]): AgentSetup["plan"] {
  const bar = plan.findIndex((s) => BAR.test(s.text));
  if (bar < 0 || plan[bar].status === "done") return plan;
  return plan.filter((s, i) => i <= bar || s.status !== "todo" || ON_THE_WAY.test(s.text));
}

/** True when `conversationId` holds the agent's setup interview. */
export async function isSetupConversation(tenant: Tenant, conversationId: string): Promise<boolean> {
  return (await getSetup(tenant))?.conversationId === conversationId;
}

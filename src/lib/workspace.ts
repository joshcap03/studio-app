import type { AgentTenantContext } from "@/lib/agent/types";
import { getConfig } from "@/lib/config";
import { recall } from "@/lib/memory";
import type { Tenant } from "@/lib/tenant";
import type { UsageSummary, WorkspaceSettings } from "@/lib/types";

// Workspace-level data: settings, usage, and the per-run agent context. All reads and writes
// go through the tenant's RLS-bound client and are filtered by the tenant's workspace id.
// Memory lives in Supermemory (src/lib/memory.ts).

function check<T>(result: { data: T; error: { message: string; code?: string; hint?: string } | null }): T {
  if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code, hint: result.error.hint });
  return result.data;
}

export async function getSettings(tenant: Tenant): Promise<WorkspaceSettings> {
  const row = check(
    await tenant.db
      .from("workspace_settings")
      .select("business_context, agent_instructions")
      .eq("workspace_id", tenant.workspace.id)
      .single(),
  ) as { business_context: string; agent_instructions: string };
  return {
    name: tenant.workspace.name,
    businessContext: row.business_context,
    agentInstructions: row.agent_instructions,
  };
}

export async function updateSettings(tenant: Tenant, patch: Partial<WorkspaceSettings>): Promise<WorkspaceSettings> {
  if (tenant.workspace.role !== "owner") throw Object.assign(new Error("Only the workspace owner can change settings."), { status: 403 });
  if (patch.name !== undefined) {
    check(await tenant.db.from("workspaces").update({ name: patch.name }).eq("id", tenant.workspace.id));
    tenant.workspace = { ...tenant.workspace, name: patch.name };
  }
  const values: Record<string, string> = {};
  if (patch.businessContext !== undefined) values.business_context = patch.businessContext;
  if (patch.agentInstructions !== undefined) values.agent_instructions = patch.agentInstructions;
  if (Object.keys(values).length > 0) {
    check(
      await tenant.db
        .from("workspace_settings")
        .update({ ...values, updated_at: new Date().toISOString() })
        .eq("workspace_id", tenant.workspace.id),
    );
  }
  return getSettings(tenant);
}

export async function getUsage(tenant: Tenant): Promise<UsageSummary> {
  const { limits } = getConfig();
  const snapshot = await usageSnapshot(tenant);
  return {
    runsToday: snapshot.workspaceToday,
    runsPerDayLimit: limits.runsPerWorkspacePerDay,
    runsPerMinuteLimit: limits.runsPerMinute,
  };
}

export async function usageSnapshot(tenant: Tenant) {
  const rows = check(await tenant.db.rpc("usage_snapshot", { ws: tenant.workspace.id })) as {
    user_last_minute: number;
    workspace_today: number;
    user_running: number;
  }[];
  const r = rows[0];
  return {
    userLastMinute: Number(r?.user_last_minute ?? 0),
    workspaceToday: Number(r?.workspace_today ?? 0),
    userRunning: Number(r?.user_running ?? 0),
  };
}

/** The limit the caller would exceed by starting another agent run, if any. */
export async function checkRunLimits(tenant: Tenant): Promise<string | null> {
  const { limits } = getConfig();
  const usage = await usageSnapshot(tenant);
  if (usage.userRunning >= limits.concurrentRuns) {
    return `You already have ${usage.userRunning} tasks running. Wait for one to finish.`;
  }
  if (usage.userLastMinute >= limits.runsPerMinute) {
    return "You're sending messages too quickly. Try again in a minute.";
  }
  if (usage.workspaceToday >= limits.runsPerWorkspacePerDay) {
    return "This workspace has reached today's message limit. It resets at midnight UTC.";
  }
  if (limits.runsServicePerDay && check(await tenant.db.rpc("service_runs_at_limit", { p_limit: limits.runsServicePerDay }))) {
    return "Studio is at capacity for today. Try again tomorrow.";
  }
  return null;
}

export async function recordRun(tenant: Tenant): Promise<void> {
  check(await tenant.db.from("usage_events").insert({ workspace_id: tenant.workspace.id, user_id: tenant.userId, kind: "agent_run" }));
}

/**
 * Everything the agent may know about this tenant for one run. Built fresh per run from
 * the caller's own session, so it can only ever contain this workspace's settings, this
 * workspace's shared memory, and this member's personal memory and connection id. `query`
 * (the member's message) pulls in memories that match it.
 */
export async function buildAgentContext(tenant: Tenant, query?: string): Promise<AgentTenantContext> {
  const [settings, memories] = await Promise.all([getSettings(tenant), recall(tenant, query)]);
  return {
    workspaceId: tenant.workspace.id,
    workspaceName: settings.name,
    userId: tenant.userId,
    composioUserId: tenant.composioUserId,
    composioToolkits: Object.fromEntries((getConfig().composio?.toolkits ?? []).map((t) => [t.slug, t.authConfigId])),
    businessContext: settings.businessContext,
    agentInstructions: settings.agentInstructions,
    memories,
  };
}

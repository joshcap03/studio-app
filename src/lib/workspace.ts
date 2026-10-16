import { storeFor } from "@/lib/chat/store-for";
import { previewEnabled } from "@/lib/flags";
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

/**
 * The caller's personal guardrail, or null. Members can read their own and never change it:
 * it's set and removed only with admin access to the database (see the user_guardrails migration).
 */
export async function getGuardrail(tenant: Tenant): Promise<string | null> {
  const row = check(
    await tenant.db.from("user_guardrails").select("instructions").eq("user_id", tenant.userId).maybeSingle(),
  ) as { instructions: string } | null;
  return row?.instructions.trim() || null;
}

// How much of the member's recent history a guardrail run sees, to notice a question coming back.
const RECENT_CHATS = 15;
const RECENT_CHATS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function guardrailForRun(tenant: Tenant, conversationId?: string): Promise<AgentTenantContext["guardrail"]> {
  const instructions = await getGuardrail(tenant);
  if (!instructions) return null;
  const recentChats = await storeFor(tenant).recentTitles(Date.now() - RECENT_CHATS_WINDOW_MS, RECENT_CHATS, conversationId);
  return { instructions, recentChats };
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

/**
 * Claims one agent run for the caller, writing to the reply `replyId`: checks every limit and
 * records the run atomically, so requests sent at the same moment can't all slip under a limit.
 * Returns the limit it would exceed (nothing is recorded then), or null once the run is claimed.
 */
export async function claimRun(tenant: Tenant, replyId?: string): Promise<string | null> {
  const { limits } = getConfig();
  const refused = check(
    await tenant.db.rpc("claim_run", {
      ws: tenant.workspace.id,
      p_concurrent: limits.concurrentRuns,
      p_per_minute: limits.runsPerMinute,
      p_per_day: limits.runsPerWorkspacePerDay,
      p_service_per_day: limits.runsServicePerDay ?? null,
      p_message_id: replyId ?? null,
    }),
  ) as string | null;
  switch (refused) {
    case null:
      return null;
    case "concurrent":
      return "You already have tasks running. Wait for one to finish.";
    case "per_minute":
      return "You're sending messages too quickly. Try again in a minute.";
    case "workspace_day":
      return "This workspace has reached today's message limit. It resets at midnight UTC.";
    default:
      return "Studio is at capacity for today. Try again tomorrow.";
  }
}

/**
 * Everything the agent may know about this tenant for one run. Built fresh per run from
 * the caller's own session, so it can only ever contain this workspace's settings, this
 * workspace's shared memory, and this member's personal memory and connection id. `query`
 * (the member's message) pulls in memories that match it. `conversationId` is the conversation
 * being answered, left out of the recent chats a guardrail run sees.
 */
export async function buildAgentContext(tenant: Tenant, query?: string, conversationId?: string): Promise<AgentTenantContext> {
  const [settings, memories, guardrail] = await Promise.all([
    getSettings(tenant),
    recall(tenant, query, { pinned: previewEnabled(tenant, "brain") }),
    guardrailForRun(tenant, conversationId),
  ]);
  return {
    workspaceId: tenant.workspace.id,
    workspaceName: settings.name,
    userId: tenant.userId,
    composioUserId: tenant.composioUserId,
    composioToolkits: Object.fromEntries((getConfig().composio?.toolkits ?? []).map((t) => [t.slug, t.authConfigId])),
    businessContext: settings.businessContext,
    agentInstructions: settings.agentInstructions,
    memories,
    guardrail,
  };
}

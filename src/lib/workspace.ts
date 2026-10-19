import { storeFor } from "@/lib/chat/store-for";
import { getCompanion } from "@/lib/companion";
import { previewEnabled } from "@/lib/flags";
import type { AgentTenantContext } from "@/lib/agent/types";
import { getConfig } from "@/lib/config";
import { recall } from "@/lib/memory";
import { taskContextFor } from "@/lib/tasks/agent";
import { listRecords } from "@/lib/tasks/records";
import { templateById } from "@/lib/templates";
import type { Tenant } from "@/lib/tenant-core";
import type { AgentSetup, Modality, UsageSummary, WorkspaceSettings } from "@/lib/types";
import { setupSkill } from "@/lib/skills/setup";
import { barScore, lastMissedBatch, recentPasses } from "@/lib/verdicts";

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
      .select("business_context, agent_instructions, template_id, setup")
      .eq("workspace_id", tenant.workspace.id)
      .single(),
  ) as { business_context: string; agent_instructions: string; template_id: string | null; setup: AgentSetup | null };
  return {
    name: tenant.workspace.name,
    profile: row.business_context,
    agentInstructions: row.agent_instructions,
    templateId: row.template_id,
    setup: row.setup ?? null,
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
  if (tenant.workspace.role !== "owner") throw Object.assign(new Error("Only the owner can change settings."), { status: 403 });
  if (patch.name !== undefined) {
    check(await tenant.db.from("workspaces").update({ name: patch.name }).eq("id", tenant.workspace.id));
    tenant.workspace = { ...tenant.workspace, name: patch.name };
  }
  const values: Record<string, string | null> = {};
  if (patch.profile !== undefined) values.business_context = patch.profile;
  if (patch.templateId !== undefined) values.template_id = patch.templateId;
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

/** Chat runs and task runs are limited separately (both count toward the service-wide cap). */
export type RunKind = "agent_run" | "task_run";

/**
 * Claims one agent run for the caller, writing to the reply `replyId`: checks every limit and
 * records the run atomically, so requests sent at the same moment can't all slip under a limit.
 * Returns the limit it would exceed (nothing is recorded then), or null once the run is claimed.
 * A task's run ("task_run") has its own concurrency and daily cap, apart from chat.
 */
export async function claimRun(tenant: Tenant, replyId?: string, kind: RunKind = "agent_run"): Promise<string | null> {
  const { limits } = getConfig();
  const task = kind === "task_run";
  const refused = check(
    await tenant.db.rpc("claim_run", {
      ws: tenant.workspace.id,
      p_concurrent: limits.concurrentRuns,
      p_per_minute: limits.runsPerMinute,
      p_per_day: task ? limits.taskRunsPerWorkspacePerDay : limits.runsPerWorkspacePerDay,
      p_service_per_day: limits.runsServicePerDay ?? null,
      p_message_id: replyId ?? null,
      p_kind: kind,
    }),
  ) as string | null;
  switch (refused) {
    case null:
      return null;
    case "concurrent":
      return task ? "Your other tasks are still running. This one will wait for its next time." : "You already have tasks running. Wait for one to finish.";
    case "per_minute":
      return task ? "Too many tasks started at once. Try again in a minute." : "You're sending messages too quickly. Try again in a minute.";
    case "workspace_day":
      return task
        ? "This agent has reached today's limit for task runs. It resets at midnight UTC."
        : "This agent has reached today's message limit. It resets at midnight UTC.";
    default:
      return "Studio is at capacity for today. Try again tomorrow.";
  }
}

/**
 * Everything the agent may know about this tenant for one run. Built fresh per run from
 * the caller's own session, so it can only ever contain this workspace's settings, this
 * workspace's shared memory, and this member's own profile, personal memory, and connection id. `query`
 * (the member's message) pulls in memories that match it. `conversationId` is the conversation
 * being answered, left out of the recent chats a guardrail run sees.
 */
export async function buildAgentContext(tenant: Tenant, query?: string, conversationId?: string, modality?: Modality): Promise<AgentTenantContext> {
  const [settings, memories, guardrail, tasks, bar, self] = await Promise.all([
    getSettings(tenant),
    recall(tenant, query, { pinned: previewEnabled(tenant, "brain") }),
    guardrailForRun(tenant, conversationId),
    // A run goes ahead without its task context rather than failing over it.
    taskContextFor(tenant, conversationId).catch((e) => {
      console.error("[context] couldn't load the task and tracker", e);
      return {};
    }),
    barFor(tenant, conversationId),
    selfFor(tenant),
  ]);
  return {
    workspaceId: tenant.workspace.id,
    workspaceName: settings.name,
    userId: tenant.userId,
    composioUserId: tenant.composioUserId,
    account: tenant.account,
    composioToolkits: Object.fromEntries((getConfig().composio?.toolkits ?? []).map((t) => [t.slug, t.authConfigId])),
    profile: settings.profile,
    agentInstructions: settings.agentInstructions,
    memories,
    guardrail,
    ...tasks,
    setup:
      conversationId && settings.setup?.conversationId === conversationId
        ? {
            plan: settings.setup.plan,
            ...(settings.setup.status === "in_progress" ? { instructions: setupSkill(settings.templateId, { call: modality === "call" }).instructions } : {}),
          }
        : null,
    notes: await notesFor(tenant, settings.templateId),
    bar,
    ...(modality && modality !== "text" ? { modality } : {}),
    ...(self ? { self } : {}),
  };
}

/** Who the agent is to this member, when companions are on; a run goes ahead without it on error. */
async function selfFor(tenant: Tenant): Promise<AgentTenantContext["self"]> {
  if (!previewEnabled(tenant, "companion")) return null;
  try {
    const { name, manner } = await getCompanion(tenant);
    return { name, manner };
  } catch (e) {
    console.error("[context] couldn't load who the agent is to the member", e);
    return null;
  }
}

/** The member's bar in practice (see src/lib/verdicts.ts); a run goes ahead without it on error. */
async function barFor(tenant: Tenant, conversationId?: string): Promise<AgentTenantContext["bar"]> {
  try {
    const [score, passes, lastBatch] = await Promise.all([barScore(tenant), recentPasses(tenant), lastMissedBatch(tenant, conversationId)]);
    return score.judged || lastBatch ? { ...score, passes, ...(lastBatch ? { lastBatch } : {}) } : undefined;
  } catch (e) {
    console.error("[context] couldn't load the member's verdicts", e);
    return undefined;
  }
}

/** How many reference rows (e.g. stories) the agent sees in every chat, per collection. */
const NOTES_PER_COLLECTION = 12;

/** The template's reference collections, with fields; a run goes ahead without them on error. */
async function notesFor(tenant: Tenant, templateId: string | null): Promise<AgentTenantContext["notes"]> {
  const collections = templateById(templateId)?.contextCollections ?? [];
  if (collections.length === 0) return undefined;
  try {
    const lists = await Promise.all(collections.map((c) => listRecords(tenant, c)));
    return lists.flatMap((rows) => rows.slice(0, NOTES_PER_COLLECTION).map((r) => ({ collection: r.collection, title: r.title || r.key, fields: r.fields })));
  } catch (e) {
    console.error("[context] couldn't load reference notes", e);
    return undefined;
  }
}

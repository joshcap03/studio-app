import type { Tenant } from "@/lib/tenant-core";
import type { AgentSetup, Companion, CompanionLook, CompanionStage } from "@/lib/types";
import { isVoiceKey, type VoiceKey } from "@/lib/voice/voices";

// Who an agent is to one member. It starts as a sketch of the Studio diamond, is drawn in as
// they work together, and is ready to introduce itself once it knows them: real conversations,
// on more than one day, with setup settled. It arrives when the member keeps the name it
// suggests. The stage only shapes how the agent looks and talks; it never gates what it can
// do. Members never read the stage names: the change is shown, not announced. How it sounds
// (its voice and manner) is the member's to choose at any stage; only the name waits.

export const COMPANION_STAGES = ["sketch", "drawn", "ready", "arrived"] as const satisfies readonly CompanionStage[];

/** When "it knows you" (tuned from how soon agents get there). */
export const KNOWS_YOU = {
  /** Chat runs before the sketch is drawn in. */
  drawnRuns: 4,
  /** Chat runs, conversations and different days before it's ready to introduce itself. */
  readyRuns: 10,
  readyConversations: 3,
  readyDays: 2,
};

export interface CompanionSignals {
  /** The member's chat runs with this agent (task runs don't count: chat is what builds it). */
  runs: number;
  /** Different (UTC) days those runs fell on. */
  days: number;
  conversations: number;
  /** Setup is done, set aside, or was never started; not mid-interview. */
  setupSettled: boolean;
}

/** The stage the member's history has earned, short of arriving (that takes the member). */
export function companionStage({ runs, days, conversations, setupSettled }: CompanionSignals): Exclude<CompanionStage, "arrived"> {
  if (setupSettled && runs >= KNOWS_YOU.readyRuns && conversations >= KNOWS_YOU.readyConversations && days >= KNOWS_YOU.readyDays) {
    return "ready";
  }
  return runs >= KNOWS_YOU.drawnRuns ? "drawn" : "sketch";
}

export const MAX_COMPANION_NAME = 40;
export const MAX_MANNER = 600;
const NAME = /^\p{L}[\p{L}\p{M}' -]*$/u;

/** A name as the agent or member wrote it, tidied, or null when it isn't one (a sentence, a link, an emoji). */
export function companionName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'\u201c\u2018]+|["'\u201d\u2019.!]+$/g, "")
    .trim();
  return name && name.length <= MAX_COMPANION_NAME && NAME.test(name) ? name : null;
}

/** Why a name won't do for this member's agent, or null when it's fine. */
export function nameProblem(name: string, { member, taken }: { member: string | null; taken: string[] }): string | null {
  const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" }) === 0;
  if (member && same(name, member)) return "That's your own name. Pick another for it.";
  if (taken.some((t) => same(t, name))) return "Another of your agents goes by that name. Pick another.";
  return null;
}

export function stageRank(stage: CompanionStage): number {
  return COMPANION_STAGES.indexOf(stage);
}

const SHAPES: CompanionLook["shape"][] = ["classic", "tall", "wide", "cushion"];
const TINTS: CompanionLook["tint"][] = ["chart-1", "chart-2", "chart-3", "chart-4"];

/** FNV-1a, so a look is the same on the server and in the browser. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** How this agent looks to this member: fixed by their ids, so it's the same everywhere, always. */
export function companionLook(workspaceId: string, userId: string): CompanionLook {
  const h = hash(`${workspaceId}:${userId}`);
  return { shape: SHAPES[h % SHAPES.length], tint: TINTS[(h >>> 4) % TINTS.length], seed: (h >>> 8) % 1000 };
}

interface CompanionRow {
  workspace_id: string;
  stage: CompanionStage;
  name: string | null;
  manner: string | null;
  voice: string | null;
}

const COLUMNS = "workspace_id, stage, name, manner, voice";

function toCompanion(workspaceId: string, userId: string, row: CompanionRow | undefined): Companion {
  return {
    workspaceId,
    stage: row?.stage ?? "sketch",
    name: row?.stage === "arrived" ? row.name : null,
    manner: row?.manner ?? null,
    // A voice since dropped from the catalog falls back to the template's.
    voice: isVoiceKey(row?.voice) ? row.voice : null,
    look: companionLook(workspaceId, userId),
  };
}

/** The member's companion for every one of their agents, by agent id. */
export async function getCompanions(tenant: Tenant): Promise<Record<string, Companion>> {
  const { data, error } = await tenant.db
    .from("agent_companions")
    .select(COLUMNS)
    .eq("user_id", tenant.userId)
    .returns<CompanionRow[]>();
  if (error) throw error;
  const rows = new Map((data ?? []).map((row) => [row.workspace_id, row]));
  return Object.fromEntries(tenant.workspaces.map((w) => [w.id, toCompanion(w.id, tenant.userId, rows.get(w.id))]));
}

async function loadRow(tenant: Tenant): Promise<CompanionRow | undefined> {
  const { data, error } = await tenant.db
    .from("agent_companions")
    .select(COLUMNS)
    .eq("workspace_id", tenant.workspace.id)
    .eq("user_id", tenant.userId)
    .maybeSingle<CompanionRow>();
  if (error) throw error;
  return data ?? undefined;
}

/** The member's companion for the agent they're in. */
export async function getCompanion(tenant: Tenant): Promise<Companion> {
  return toCompanion(tenant.workspace.id, tenant.userId, await loadRow(tenant));
}

/** Writes the member's row for this agent, creating it on first write. */
async function saveRow(tenant: Tenant, exists: boolean, values: Partial<Omit<CompanionRow, "workspace_id">> & { arrived_at?: string; suggested_name?: string | null }) {
  const now = new Date().toISOString();
  const update = () =>
    tenant.db.from("agent_companions").update({ ...values, updated_at: now }).eq("workspace_id", tenant.workspace.id).eq("user_id", tenant.userId);
  let { error } = exists ? await update() : await tenant.db.from("agent_companions").insert({ ...values, workspace_id: tenant.workspace.id, updated_at: now });
  // Another run created it a moment ago.
  if (error?.code === "23505") ({ error } = await update());
  if (error) throw error;
}

// Enough recent runs to see the thresholds; older ones don't change the answer.
const SIGNAL_RUNS = 200;

/** What the member's own history with this agent says, from rows they can't delete. */
export async function companionSignals(tenant: Tenant, setup: AgentSetup | null): Promise<CompanionSignals> {
  const [runs, conversations] = await Promise.all([
    tenant.db
      .from("usage_events")
      .select("created_at")
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId)
      .eq("kind", "agent_run")
      .order("created_at", { ascending: false })
      .limit(SIGNAL_RUNS)
      .returns<{ created_at: string }[]>(),
    tenant.db
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId),
  ]);
  if (runs.error) throw runs.error;
  if (conversations.error) throw conversations.error;
  const rows = runs.data ?? [];
  return {
    runs: rows.length,
    days: new Set(rows.map((r) => new Date(r.created_at).toISOString().slice(0, 10))).size,
    conversations: conversations.count ?? 0,
    setupSettled: setup?.status !== "in_progress",
  };
}

/**
 * Moves the member's companion forward to the stage their history has earned (never back,
 * and never to arrived, which takes the member keeping a name). Called after each chat run.
 */
export async function refreshCompanion(tenant: Tenant, setup: AgentSetup | null): Promise<Companion> {
  const row = await loadRow(tenant);
  const current = toCompanion(tenant.workspace.id, tenant.userId, row);
  if (stageRank(current.stage) >= stageRank("ready")) return current;
  const earned = companionStage(await companionSignals(tenant, setup));
  if (stageRank(earned) <= stageRank(current.stage)) return current;
  await saveRow(tenant, Boolean(row), { stage: earned });
  return { ...current, stage: earned };
}

/** The names the member's other agents go by, so two never share one. */
async function takenNames(tenant: Tenant): Promise<string[]> {
  const all = await getCompanions(tenant);
  return Object.values(all).flatMap((c) => (c.workspaceId !== tenant.workspace.id && c.name ? [c.name] : []));
}

export type NameResult = { ok: true; companion: Companion } | { ok: false; error: string };

/**
 * The member kept a name (the one the agent suggested, or their own pick): the agent arrives
 * with it. Also how a member renames it later. The manner they have always stays (they chose it,
 * or kept it with an earlier introduction; they change it with setCompanionSound): a `manner`
 * given with the name, in the agent's words, is taken only when there's none yet. `suggested`
 * is what the agent offered, kept to see how often members keep it.
 */
export async function nameCompanion(
  tenant: Tenant,
  { name: raw, manner, suggested, member }: { name: string; manner?: string; suggested?: string; member: string | null },
): Promise<NameResult> {
  const name = companionName(raw);
  if (!name) return { ok: false, error: "Use a short name: letters, spaces, hyphens or apostrophes." };
  const problem = nameProblem(name, { member, taken: await takenNames(tenant) });
  if (problem) return { ok: false, error: problem };
  const row = await loadRow(tenant);
  const arriving = row?.stage !== "arrived";
  const kept = row?.manner ?? (manner?.trim().slice(0, MAX_MANNER) || null);
  await saveRow(tenant, Boolean(row), {
    stage: "arrived",
    name,
    manner: kept,
    ...(suggested !== undefined ? { suggested_name: companionName(suggested) } : {}),
    ...(arriving ? { arrived_at: new Date().toISOString() } : {}),
  });
  return { ok: true, companion: toCompanion(tenant.workspace.id, tenant.userId, { workspace_id: tenant.workspace.id, voice: row?.voice ?? null, stage: "arrived", name, manner: kept }) };
}

/**
 * The member chose how it sounds with them: its voice on calls (null goes back to its
 * template's), and how it talks, in its words (an empty manner clears it). At any stage:
 * choosing never makes it arrive.
 */
export async function setCompanionSound(tenant: Tenant, sound: { voice?: VoiceKey | null; manner?: string }): Promise<Companion> {
  const row = await loadRow(tenant);
  const values = {
    ...(sound.voice !== undefined ? { voice: sound.voice } : {}),
    ...(sound.manner !== undefined ? { manner: sound.manner.trim().slice(0, MAX_MANNER) || null } : {}),
  };
  if (Object.keys(values).length) await saveRow(tenant, Boolean(row), values);
  const before: CompanionRow = row ?? { workspace_id: tenant.workspace.id, stage: "sketch", name: null, manner: null, voice: null };
  return toCompanion(tenant.workspace.id, tenant.userId, { ...before, ...values });
}

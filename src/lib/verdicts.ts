import type { Tenant } from "@/lib/tenant-core";
import { MAX_FORM_FIELDS, MAX_VERDICT_ITEMS, type UiForm, type Verdict } from "@/lib/types";

// A member's keep/pass calls on results the agent showed them in a verdict field (see
// supabase/migrations/20261029000000_agent_verdicts.sql). The one score in the app is theirs:
// how much of what the agent brought them they kept. Everything goes through the member's
// session, so RLS keeps each member to their own verdicts.

function check<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

/** One call as the card sends it: which field and item, keep or pass, and why. */
export interface VerdictCall {
  fieldId: string;
  itemId: string;
  verdict: Verdict;
  reason?: string;
}

/**
 * Saves the member's calls on a sent form's verdict fields. Items and their titles come from
 * the stored card, never the request; calls on anything not in it are dropped. Returns how many
 * were saved.
 */
export async function saveVerdicts(
  tenant: Tenant,
  form: UiForm,
  where: { messageId: string; taskId: string | null },
  calls: VerdictCall[],
): Promise<number> {
  const rows = [];
  const seen = new Set<string>();
  for (const call of calls) {
    const field = form.fields.find((f) => f.id === call.fieldId);
    const item = field?.kind === "verdict" ? field.items.find((i) => i.id === call.itemId) : undefined;
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    const reason = call.verdict === "pass" ? call.reason?.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    rows.push({
      workspace_id: tenant.workspace.id,
      user_id: tenant.userId,
      message_id: where.messageId,
      block_id: form.id,
      item_id: item.id,
      title: item.title.slice(0, 200),
      verdict: call.verdict,
      reason: reason || null,
      task_id: where.taskId,
    });
  }
  if (rows.length === 0) return 0;
  check(await tenant.db.from("agent_verdicts").upsert(rows, { onConflict: "message_id,block_id,item_id", ignoreDuplicates: true }));
  return rows.length;
}

/** How the member's bar is holding up: what they kept, of what they judged, lately. */
export interface BarScore {
  kept: number;
  judged: number;
  days: number;
}

const DAY = 24 * 60 * 60 * 1000;

/** The member's kept ratio over the last `days` (for one task when `taskId` is given). */
export async function barScore(tenant: Tenant, opts: { taskId?: string; days?: number } = {}): Promise<BarScore> {
  const days = opts.days ?? 7;
  let query = tenant.db
    .from("agent_verdicts")
    .select("verdict")
    .eq("workspace_id", tenant.workspace.id)
    .eq("user_id", tenant.userId)
    .gte("created_at", new Date(Date.now() - days * DAY).toISOString())
    .limit(1000);
  if (opts.taskId) query = query.eq("task_id", opts.taskId);
  const rows = check(await query) as { verdict: Verdict }[];
  return { kept: rows.filter((r) => r.verdict === "keep").length, judged: rows.length, days };
}

/** What the member passed on lately and why, newest first, for the agent to learn from. */
export async function recentPasses(tenant: Tenant, limit = 6): Promise<{ title: string; reason: string | null }[]> {
  const rows = check(
    await tenant.db
      .from("agent_verdicts")
      .select("title, reason")
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId)
      .eq("verdict", "pass")
      .gte("created_at", new Date(Date.now() - 30 * DAY).toISOString())
      .order("created_at", { ascending: false })
      .limit(limit),
  ) as { title: string; reason: string | null }[];
  return rows;
}

/** One result on a card the member judged, with their call. */
export interface JudgedItem {
  title: string;
  verdict: Verdict;
  reason: string | null;
}

/**
 * The last card the member judged, when it missed (see `missed`). `since` is what they've said
 * to this agent in other chats since then, so the agent can tell whether they've already said
 * what to look for instead.
 */
export interface MissedBatch {
  judged: number;
  kept: number;
  items: JudgedItem[];
  since: string[];
}

/** A batch missed when the member passed on at least three quarters of it (two results or more). */
export function missed(items: { verdict: Verdict }[]): boolean {
  const passed = items.filter((i) => i.verdict === "pass").length;
  return items.length >= 2 && passed * 4 >= items.length * 3;
}

const SINCE_LINES = 3;
const SINCE_CHARS = 200;

/**
 * The last card the member judged, if they passed on most of it. What they said after it comes
 * from chats other than `conversationId` (the agent sees the chat it's answering), without the
 * card's own answer or task briefs.
 */
export async function lastMissedBatch(tenant: Tenant, conversationId?: string): Promise<MissedBatch | undefined> {
  const rows = check(
    await tenant.db
      .from("agent_verdicts")
      .select("message_id, block_id, title, verdict, reason")
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId)
      .gte("created_at", new Date(Date.now() - 30 * DAY).toISOString())
      .order("created_at", { ascending: false })
      .limit(MAX_FORM_FIELDS * MAX_VERDICT_ITEMS),
  ) as { message_id: string; block_id: string; title: string; verdict: Verdict; reason: string | null }[];
  const newest = rows[0];
  if (!newest) return undefined;
  const batch = rows.filter((r) => r.message_id === newest.message_id && r.block_id === newest.block_id);
  if (!missed(batch)) return undefined;

  const card = check(await tenant.db.from("messages").select("conversation_id, seq").eq("id", newest.message_id).maybeSingle()) as {
    conversation_id: string;
    seq: number;
  } | null;
  let since: string[] = [];
  if (card) {
    const later = check(
      await tenant.db
        .from("messages")
        .select("conversation_id, content, origin")
        .eq("workspace_id", tenant.workspace.id)
        .eq("user_id", tenant.userId)
        .eq("role", "user")
        .gt("seq", card.seq)
        .order("seq", { ascending: true })
        .limit(10),
    ) as { conversation_id: string; content: string; origin: { kind?: string } | null }[];
    // The first of them in the card's chat is the card's own answer.
    const answer = later.find((m) => m.conversation_id === card.conversation_id);
    since = later
      .filter((m) => m !== answer && m.conversation_id !== conversationId && m.origin?.kind !== "task")
      .map((m) => m.content.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(-SINCE_LINES)
      .map((t) => (t.length > SINCE_CHARS ? `${t.slice(0, SINCE_CHARS - 1)}…` : t));
  }
  return {
    judged: batch.length,
    kept: batch.filter((r) => r.verdict === "keep").length,
    items: batch.map((r) => ({ title: r.title, verdict: r.verdict, reason: r.reason })),
    since,
  };
}

/** "4 of 5 kept this week", or null before there's anything to count. */
export function describeScore(score: BarScore): string | null {
  if (score.judged === 0) return null;
  const when = score.days === 7 ? "this past week" : `in the last ${score.days} days`;
  return `${score.kept} of ${score.judged} kept ${when}`;
}

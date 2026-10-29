import { z } from "zod";
import { getCompanions } from "@/lib/companion";
import { completeJson, type LlmConfig } from "@/lib/llm";
import { templateById } from "@/lib/templates";
import type { Tenant } from "@/lib/tenant-core";
import type { RouteResult } from "@/lib/types";

// Which of the member's agents takes an ask typed on Home. Only agents that are on Home are
// candidates, and only the member's own: the cards are built from rows Row Level Security
// already lets them read, and the answer maps a number back to one of those cards, never an id
// the model made up. The ask itself is never logged. Studio's small model decides when one is
// configured (src/lib/llm.ts); otherwise, and whenever it fails, keyword overlap does, and says
// it isn't sure unless one agent clearly wins, so Home asks the member instead of guessing.

/** What the router knows about one agent: enough to tell what it's for, never its whole setup. */
export interface AgentCard {
  id: string;
  name: string;
  companionName: string | null;
  /** Its template's one-line description, when it started from one. */
  template: string | null;
  /** The start of "what this agent is for". */
  profile: string;
  recentTitles: string[];
  taskTitles: string[];
}

export const PROFILE_EXCERPT = 300;
export const CARD_TITLES = 5;
export const ROUTE_TEXT_MAX = 1500;
const RECENT_ROWS = 40;

type Rows<T> = { data: T[] | null; error: { message: string } | null };

/** One card per agent on Home, in the member's order. */
export async function agentCards(tenant: Tenant): Promise<AgentCard[]> {
  const agents = tenant.workspaces.filter((w) => w.onHome);
  const ids = agents.map((w) => w.id);
  if (ids.length === 0) return [];
  const [settings, companions, chats, tasks] = await Promise.all([
    tenant.db.from("workspace_settings").select("workspace_id, template_id, business_context").in("workspace_id", ids) as unknown as Promise<
      Rows<{ workspace_id: string; template_id: string | null; business_context: string | null }>
    >,
    getCompanions(tenant).catch(() => ({}) as Awaited<ReturnType<typeof getCompanions>>),
    tenant.db
      .from("conversations")
      .select("workspace_id, title")
      .eq("user_id", tenant.userId)
      .in("workspace_id", ids)
      .order("updated_at", { ascending: false })
      .limit(RECENT_ROWS) as unknown as Promise<Rows<{ workspace_id: string; title: string }>>,
    tenant.db
      .from("agent_tasks")
      .select("workspace_id, title")
      .eq("user_id", tenant.userId)
      .in("workspace_id", ids)
      .in("status", ["active", "paused"])
      .limit(RECENT_ROWS) as unknown as Promise<Rows<{ workspace_id: string; title: string }>>,
  ]);
  if (settings.error) throw new Error(settings.error.message);
  const byId = new Map((settings.data ?? []).map((s) => [s.workspace_id, s]));
  const titles = (rows: { workspace_id: string; title: string }[] | null, id: string) =>
    (rows ?? []).filter((r) => r.workspace_id === id).map((r) => r.title.trim()).filter(Boolean).slice(0, CARD_TITLES);
  return agents.map((w) => {
    const s = byId.get(w.id);
    return {
      id: w.id,
      name: w.name,
      companionName: companions[w.id]?.name ?? null,
      template: s?.template_id ? (templateById(s.template_id)?.description ?? null) : null,
      profile: excerpt(s?.business_context ?? ""),
      recentTitles: titles(chats.data, w.id),
      taskTitles: titles(tasks.data, w.id),
    };
  });
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PROFILE_EXCERPT ? `${flat.slice(0, PROFILE_EXCERPT - 1).trimEnd()}…` : flat;
}

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "what", "should", "can", "could", "would", "you", "please", "about", "from", "into", "our",
  "your", "get", "have", "has", "are", "was", "were", "will", "just", "like", "some", "any", "all", "how", "when", "where", "who", "why",
  "them", "they", "their", "there", "then", "than", "also", "but", "not", "out", "over", "need", "want", "make", "help", "let", "its",
]);

/** Lowercase words of three letters or more, without the small words, singular-ish ("invoices" meets "invoice"). */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/**
 * Keyword overlap between the ask and each card: an agent's name (or its companion's) counts
 * most, then what it's for and its recent chats and tasks. Sure only when one agent clearly
 * wins; with no hits at all, the agent the member was last in, not sure.
 */
export function heuristicRoute(text: string, cards: AgentCard[], lastUsed: string): RouteResult {
  const ask = words(text);
  if (cards.length === 0) return { workspaceId: lastUsed, sure: false, by: "last" };
  const scored = cards
    .map((card) => {
      const names = new Set(words([card.name, card.companionName ?? ""].join(" ")));
      const about = new Set(words([card.template ?? "", card.profile].join(" ")));
      const titles = new Set(words([...card.recentTitles, ...card.taskTitles].join(" ")));
      let score = 0;
      for (const w of ask) {
        if (names.has(w)) score += 3;
        if (about.has(w)) score += 1;
        if (titles.has(w)) score += 1;
      }
      return { card, score };
    })
    .sort((a, b) => b.score - a.score);
  const [top, second] = scored;
  if (!top || top.score === 0) return { workspaceId: lastUsed, sure: false, by: "last" };
  const sure = top.score >= 2 && (!second || top.score >= second.score * 2);
  return { workspaceId: top.card.id, sure, by: "heuristic" };
}

/** The question put to the model: the ask, and the agents numbered (never their ids). */
export function routePrompt(text: string, cards: AgentCard[]): { system: string; user: string } {
  const system =
    "You pick which of one person's assistants should take their message. Each assistant is numbered, with its name, what it's for, and its recent work. " +
    'Reply with JSON only: {"agent": <number>, "sure": true|false}. Pick the assistant whose purpose and recent work fit the message best. ' +
    "Set sure to false when two fit about equally or none fits.";
  const list = cards
    .map((c, i) => {
      const name = c.companionName ? `${c.name} (goes by ${c.companionName})` : c.name;
      return `${i + 1}. ${name} — ${c.template ?? "general"}. About: ${c.profile || "nothing written yet"}. Recent chats: ${c.recentTitles.join("; ") || "none"}. Tasks: ${c.taskTitles.join("; ") || "none"}`;
    })
    .join("\n");
  return { system, user: `Message:\n"""${text.slice(0, ROUTE_TEXT_MAX)}"""\n\nAssistants:\n${list}` };
}

/** The model's answer: one of the numbered agents, and whether it's sure. */
export const routeAnswer = (count: number) =>
  z.object({ agent: z.coerce.number().int().min(1).max(count), sure: z.boolean().default(false) });

/**
 * Which agent takes `text`. One agent on Home needs no decision; otherwise the model when there is
 * one, else (or on any failure) keyword overlap. Always one of the member's agents on Home.
 */
export async function routeAsk(tenant: Tenant, text: string, { llm }: { llm?: LlmConfig | null } = {}): Promise<RouteResult> {
  const cards = await agentCards(tenant);
  const last = cards.some((c) => c.id === tenant.workspace.id) ? tenant.workspace.id : (cards[0]?.id ?? tenant.workspace.id);
  if (cards.length === 0) return { workspaceId: last, sure: false, by: "last" };
  if (cards.length === 1) return { workspaceId: cards[0].id, sure: true, by: "last" };
  if (llm) {
    const { system, user } = routePrompt(text, cards);
    const answer = await completeJson(llm, { system, user, schema: routeAnswer(cards.length), maxTokens: 30 });
    if (answer) return { workspaceId: cards[answer.agent - 1].id, sure: answer.sure, by: "model" };
  }
  return heuristicRoute(text, cards, last);
}

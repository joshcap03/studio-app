import { marksOf, type MarkedMove } from "@/lib/chat/move";
import { createStore } from "@/lib/db/store";
import type { Tenant } from "@/lib/tenant-core";
import type { HomeConversation, HomeData } from "@/lib/types";

// Home: one place across the member's agents, where an ask is routed to the right one
// (src/lib/route.ts) and their latest chats from every agent on Home are listed. Everything here
// is the member's own: Row Level Security limits `conversations` to their rows in agents they
// belong to, and the explicit filters say so again. Each chat stays with the agent it started in.

/** How many recent chats Home lists across agents. */
export const HOME_RECENT = 50;

/** The member's latest chats across their agents on Home, newest first, each naming its agent. */
export async function listRecentAcrossAgents(tenant: Tenant, limit = HOME_RECENT): Promise<HomeConversation[]> {
  const ids = tenant.workspaces.filter((w) => w.onHome).map((w) => w.id);
  if (ids.length === 0) return [];
  const { data, error } = await tenant.db
    .from("conversations")
    .select("id, title, project_id, workspace_id, created_at, updated_at")
    .eq("user_id", tenant.userId)
    .in("workspace_id", ids)
    .order("updated_at", { ascending: false })
    .limit(limit)
    .returns<{ id: string; title: string; project_id: string | null; workspace_id: string; created_at: string; updated_at: string }[]>();
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id,
    title: r.title,
    projectId: r.project_id,
    workspaceId: r.workspace_id,
    createdAt: Date.parse(r.created_at),
    updatedAt: Date.parse(r.updated_at),
  }));
}

/** Whose move it is in each of those chats, asked of each agent's store in turn (best effort: nothing on failure). */
export async function movesAcrossAgents(tenant: Tenant, conversations: HomeConversation[]): Promise<Record<string, MarkedMove>> {
  const byAgent = new Map<string, string[]>();
  for (const c of conversations) byAgent.set(c.workspaceId, [...(byAgent.get(c.workspaceId) ?? []), c.id]);
  try {
    const lasts = await Promise.all(
      [...byAgent].map(([workspaceId, ids]) => createStore(tenant.db, { workspaceId, userId: tenant.userId }).lastMessages(ids)),
    );
    return marksOf(Object.assign({}, ...lasts));
  } catch (error) {
    console.error("[home] moves unavailable", error);
    return {};
  }
}

/** Everything Home shows across the member's agents. */
export async function loadHome(tenant: Tenant): Promise<HomeData> {
  const conversations = await listRecentAcrossAgents(tenant);
  return { conversations, moves: await movesAcrossAgents(tenant, conversations) };
}

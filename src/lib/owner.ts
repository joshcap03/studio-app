import type { Session } from "@/lib/tenant-core";

// Which of the caller's agents holds a row they're opening by its link (a chat from a push, a
// chat on Home from another agent). Only their own rows answer: Row Level Security limits each
// of these tables to the member's rows in agents they belong to, and the user filter says so
// again. The page then renders for that agent rather than the one the tab was on.

export type Owned = "conversations" | "projects" | "agent_tasks";

/** The agent (workspace id) that holds this row of the caller's, or null when they have none by that id. */
export async function ownerOf(session: Session, table: Owned, id: string): Promise<string | null> {
  const { data, error } = await session.db.from(table).select("workspace_id").eq("id", id).eq("user_id", session.userId).maybeSingle<{ workspace_id: string }>();
  if (error) {
    console.error("[owner] lookup failed", error);
    return null;
  }
  return data?.workspace_id ?? null;
}

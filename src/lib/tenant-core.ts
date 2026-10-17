import type { Db } from "@/lib/supabase/db";
import type { WorkspaceSummary } from "@/lib/types";

// Tenancy without the request: given a client already authenticated as one user, resolves
// which workspace they act in, checked against their memberships under RLS. Request and
// page helpers live in tenant.ts; this file stays free of Next.js so a background worker
// can run as a member too.

export interface Session {
  db: Db;
  userId: string;
  email: string | null;
}

export interface Tenant extends Session {
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  /** The person's private id for tool connections (Composio user id), shared by all their agents. */
  composioUserId: string;
  /** Who the person is, as they told Studio. Shared by all their agents. */
  account: AccountProfile;
}

export interface AccountProfile {
  name: string;
  about: string;
}

/** A session for a user the client has already authenticated as (verified with Supabase Auth). */
export function sessionFor(db: Db, user: { id: string; email?: string | null }): Session {
  return { db, userId: user.id, email: user.email ?? null };
}

interface MembershipRow {
  workspace_id: string;
  role: "owner" | "member";
  created_at: string;
  workspaces: { name: string } | null;
}

interface AccountRow {
  display_name: string;
  about: string;
  composio_user_id: string;
}

/** The caller's account, created on first use (see the accounts migration). */
export async function ensureAccount(session: Session): Promise<AccountRow> {
  const { data, error } = await session.db.rpc("ensure_account").single<AccountRow>();
  if (error) throw error;
  return data;
}

/** The member's workspace `preferred`, if they belong to it, else their first; null without one. */
export async function resolveTenant(session: Session, preferred?: string | null): Promise<Tenant | null> {
  const [{ data, error }, account] = await Promise.all([
    session.db
      .from("workspace_members")
      .select("workspace_id, role, created_at, workspaces(name)")
      .eq("user_id", session.userId)
      .order("created_at", { ascending: true })
      .returns<MembershipRow[]>(),
    ensureAccount(session),
  ]);
  if (error) throw error;
  if (!data || data.length === 0) return null;

  const workspaces: WorkspaceSummary[] = data.map((m) => ({
    id: m.workspace_id,
    name: m.workspaces?.name ?? "Workspace",
    role: m.role,
  }));
  const active = data.find((m) => m.workspace_id === preferred) ?? data[0];
  return {
    ...session,
    workspaces,
    workspace: workspaces.find((w) => w.id === active.workspace_id)!,
    composioUserId: account.composio_user_id,
    account: { name: account.display_name, about: account.about },
  };
}

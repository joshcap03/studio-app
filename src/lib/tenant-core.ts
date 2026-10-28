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

/** What resolve_tenant returns (see its migration): the account, and memberships oldest first. */
interface ResolvedTenant {
  account: Pick<AccountRow, "display_name" | "about" | "composio_user_id">;
  memberships: { workspace_id: string; role: "owner" | "member"; name: string | null }[];
}

/**
 * The member's workspace `preferred`, if they belong to it, else their first; null without one.
 * One round trip: the account (created on first use) and the memberships come back together.
 */
export async function resolveTenant(session: Session, preferred?: string | null): Promise<Tenant | null> {
  const { data, error } = await session.db.rpc("resolve_tenant");
  if (error) throw error;
  const { account, memberships } = data as ResolvedTenant;
  if (!memberships?.length) return null;

  const workspaces: WorkspaceSummary[] = memberships.map((m) => ({
    id: m.workspace_id,
    name: m.name ?? "Workspace",
    role: m.role,
  }));
  return {
    ...session,
    workspaces,
    workspace: workspaces.find((w) => w.id === preferred) ?? workspaces[0],
    composioUserId: account.composio_user_id,
    account: { name: account.display_name, about: account.about },
  };
}

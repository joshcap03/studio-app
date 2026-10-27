import { isStandingKind, type StandingKind } from "@/lib/approvals/standing";
import { ensureAccount, type AccountProfile, type Session } from "@/lib/tenant-core";

// The person's own profile: their name and what they've told Studio about themself. It
// belongs to the login, not to one agent, so every one of their agents reads it. Reads and
// writes go through the caller's session; RLS limits them to their own row.

export const MAX_ACCOUNT_NAME = 80;
export const MAX_ACCOUNT_ABOUT = 4000;

export async function getAccount(session: Session): Promise<AccountProfile> {
  const row = await ensureAccount(session);
  return { name: row.display_name, about: row.about };
}

export async function updateAccount(session: Session, patch: Partial<AccountProfile>): Promise<AccountProfile> {
  await ensureAccount(session);
  const change: Record<string, string> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) change.display_name = patch.name;
  if (patch.about !== undefined) change.about = patch.about;
  const { data, error } = await session.db
    .from("accounts")
    .update(change)
    .eq("user_id", session.userId)
    .select("display_name, about")
    .single<{ display_name: string; about: string }>();
  if (error) throw error;
  return { name: data.display_name, about: data.about };
}

/**
 * The kinds of change the person has OK'd for good (src/lib/approvals/standing.ts): any run of
 * any of their agents approves a request of one of these kinds itself. Read fresh each time, so
 * an OK taken back stops the next request. Empty when it can't be read (fails closed).
 */
export async function getAllowedActions(session: Session): Promise<StandingKind[]> {
  const { data, error } = await session.db
    .from("accounts")
    .select("allowed_actions")
    .eq("user_id", session.userId)
    .maybeSingle<{ allowed_actions: string[] | null }>();
  if (error) throw error;
  return (data?.allowed_actions ?? []).filter(isStandingKind);
}

/**
 * Adds or takes back the person's standing OK for one kind of change. Given only from their tap
 * on a request of that kind; taken back in Settings. Resolves to the kinds now allowed.
 */
export async function setAllowedAction(session: Session, kind: StandingKind, allowed: boolean): Promise<StandingKind[]> {
  await ensureAccount(session);
  const current = await getAllowedActions(session);
  const next = allowed ? [...new Set([...current, kind])] : current.filter((k) => k !== kind);
  if (next.length === current.length && next.every((k) => current.includes(k))) return current;
  const { data, error } = await session.db
    .from("accounts")
    .update({ allowed_actions: next, updated_at: new Date().toISOString() })
    .eq("user_id", session.userId)
    .select("allowed_actions")
    .single<{ allowed_actions: string[] }>();
  if (error) throw error;
  return data.allowed_actions.filter(isStandingKind);
}

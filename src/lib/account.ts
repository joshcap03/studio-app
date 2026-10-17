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

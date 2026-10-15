import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Integration helpers. These run against the local Supabase stack (`supabase start`), never
// a hosted project: they create throwaway accounts with random emails.

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(SUPABASE_URL)) {
  throw new Error("Integration tests only run against a local Supabase stack.");
}

export interface TestAccount {
  email: string;
  password: string;
  userId: string;
  client: SupabaseClient;
}

export async function createAccount(label: string): Promise<TestAccount> {
  const email = `${label}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const password = `pw-${crypto.randomUUID()}`;
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signUp({ email, password });
  if (error || !data.user) throw error ?? new Error("sign-up returned no user");
  if (!data.session) throw new Error("sign-up returned no session; disable email confirmation for local tests");
  return { email, password, userId: data.user.id, client };
}

export async function createWorkspace(account: TestAccount, name: string): Promise<string> {
  const { data, error } = await account.client.rpc("create_workspace", { p_name: name, p_business_context: `${name} context` });
  if (error) throw error;
  return data as string;
}

/**
 * Adds an account to a workspace as a plain member. The app has no invite flow yet, so this
 * goes through the local stack's admin key (tests only; never on a request path).
 */
export async function addMember(account: TestAccount, workspaceId: string): Promise<void> {
  const { execSync } = await import("node:child_process");
  const status = JSON.parse(execSync("npx supabase status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString()) as {
    SERVICE_ROLE_KEY: string;
  };
  const admin = createClient(SUPABASE_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { error } = await admin
    .from("workspace_members")
    .insert({ workspace_id: workspaceId, user_id: account.userId, role: "member", composio_user_id: `test_${crypto.randomUUID()}` });
  if (error) throw error;
}

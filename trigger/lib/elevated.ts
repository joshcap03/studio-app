import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// The only code that holds the Supabase secret key (see AGENTS.md; a test fails if it shows
// up anywhere else). It's used for exactly two things:
//   1. the service_role-only worker_* functions that find due tasks and move their schedule on;
//   2. issuing a one-time sign-in for a task's member, so the run happens as them under RLS.
// The admin client never reads or writes tables. The member's session goes only to the app
// (trigger/run-task.ts), which runs the task as them with its own settings and keys.

const authOnly = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const supabaseUrl = () => env("NEXT_PUBLIC_SUPABASE_URL");

function adminClient(): SupabaseClient {
  return createClient(supabaseUrl(), env("SUPABASE_SECRET_KEY"), { auth: authOnly });
}

/** A run the scheduler claimed: one active task's run for one scheduled time. */
export interface ClaimedRun {
  runId: string;
  taskId: string;
  workspaceId: string;
  userId: string;
  scheduledFor: string;
  /** Only "queued" runs are started; others were picked up by an earlier dispatch. */
  runStatus: string;
  schedule: unknown;
  timezone: string;
}

interface ClaimRow {
  run_id: string;
  task_id: string;
  workspace_id: string;
  user_id: string;
  scheduled_for: string;
  run_status: string;
  schedule: unknown;
  timezone: string;
}

/** Claims up to `limit` due tasks, recording one run each (the same run again if it exists). */
export async function claimDueTasks(limit: number): Promise<ClaimedRun[]> {
  const { data, error } = await adminClient().rpc("worker_claim_due_tasks", { p_limit: limit });
  if (error) throw error;
  return ((data ?? []) as ClaimRow[]).map((r) => ({
    runId: r.run_id,
    taskId: r.task_id,
    workspaceId: r.workspace_id,
    userId: r.user_id,
    scheduledFor: r.scheduled_for,
    runStatus: r.run_status,
    schedule: r.schedule,
    timezone: r.timezone,
  }));
}

/** Moves a task's next run from `due` to `next`, unless the member changed it meanwhile. */
export async function setNextRun(taskId: string, due: string, next: Date | null): Promise<boolean> {
  const { data, error } = await adminClient().rpc("worker_set_next_run", {
    p_task: taskId,
    p_due: due,
    p_next: next?.toISOString() ?? null,
  });
  if (error) throw error;
  return data === true;
}

/** The member no longer exists or can't sign in (deleted, banned): their run is skipped. */
export class MemberUnavailable extends Error {}

/** Supabase Auth refused the sign-in for its rate limit (~6 a minute per IP hosted): try later. */
export class SignInRateLimited extends Error {}

/**
 * Opens a short-lived Auth session as one member. No email is sent. The member is looked up by
 * the user id from the claimed row, never by anything a member could edit, and the session is
 * checked to be theirs before it's used.
 */
async function openMemberSession(userId: string): Promise<{ accessToken: string; close: () => Promise<void> }> {
  const admin = adminClient();
  const { data: found, error: lookup } = await admin.auth.admin.getUserById(userId);
  if (lookup || !found.user?.email) throw new MemberUnavailable(`member ${userId} is unavailable`);
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email: found.user.email });
  if (linkError) throw new MemberUnavailable(`couldn't issue a sign-in for member ${userId}`);

  const db = createClient(supabaseUrl(), env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
  });
  const { data, error } = await db.auth.verifyOtp({ type: "magiclink", token_hash: link.properties.hashed_token });
  if (error?.status === 429) throw new SignInRateLimited(error.message);
  if (error) throw new MemberUnavailable(`member ${userId} couldn't sign in: ${error.message}`);
  // Local scope ends only this session; the member's own devices stay signed in.
  const close = async () => {
    await db.auth.signOut({ scope: "local" });
  };
  if (!data.session || data.session.user.id !== userId) {
    await close();
    throw new Error("The sign-in opened a session for someone else.");
  }
  return { accessToken: data.session.access_token, close };
}

/**
 * Runs `fn` with one session's access token as the member, always signing it out afterwards.
 * The token is short-lived and goes nowhere but the app; never log it.
 */
export async function asMember<T>(userId: string, fn: (accessToken: string) => Promise<T>): Promise<T> {
  const { accessToken, close } = await openMemberSession(userId);
  try {
    return await fn(accessToken);
  } finally {
    await close().catch((e) => console.error("[worker] couldn't sign the member's session out", e));
  }
}

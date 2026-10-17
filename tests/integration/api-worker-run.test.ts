import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./helpers";

// The route the background worker calls to start a queued run: it takes only a member's
// access token, runs only that member's own queued run, and runs it in the app (mock agent).
// The members are fixed accounts the QA server allowlists for the tasks preview (qa:serve).
// Requires the QA server on APP_URL.

const APP = process.env.APP_URL ?? "http://127.0.0.1:3100";
const PASSWORD = "pw-local-worker-route-only";

interface Member {
  db: SupabaseClient;
  token: string;
  workspaceId: string;
}

async function member(email: string): Promise<Member> {
  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const signedIn = await db.auth.signInWithPassword({ email, password: PASSWORD });
  const session = signedIn.data.session ?? (await db.auth.signUp({ email, password: PASSWORD })).data.session;
  expect(session).toBeTruthy();
  const { data: rows } = await db.from("workspace_members").select("workspace_id").limit(1);
  let workspaceId = rows?.[0]?.workspace_id as string | undefined;
  if (!workspaceId) {
    const created = await db.rpc("create_workspace", { p_name: `${email.split("@")[0]} space` });
    expect(created.error).toBeNull();
    workspaceId = created.data as string;
  }
  return { db, token: session!.access_token, workspaceId };
}

let alice: Member;
let bob: Member;

beforeAll(async () => {
  const health = await fetch(`${APP}/login`).catch(() => null);
  if (!health) throw new Error(`QA server not reachable at ${APP}; run npm run qa:serve`);
  alice = await member("worker-route-alice@example.test");
  bob = await member("worker-route-bob@example.test");
}, 60_000);

/** One of Alice's tasks with a run queued for now, as the dispatcher leaves it. */
async function queuedRun(instructions = "Find roles that fit."): Promise<{ taskId: string; runId: string }> {
  const task = await alice.db.from("agent_tasks").insert({ workspace_id: alice.workspaceId, title: "Worker route", instructions }).select("id").single();
  expect(task.error).toBeNull();
  const run = await alice.db
    .from("agent_task_runs")
    .insert({ task_id: task.data!.id, workspace_id: alice.workspaceId, scheduled_for: new Date().toISOString() })
    .select("id")
    .single();
  expect(run.error).toBeNull();
  return { taskId: task.data!.id, runId: run.data!.id };
}

const start = (path: { taskId: string; runId: string }, workspaceId: string, headers: Record<string, string> = {}) =>
  fetch(`${APP}/api/tasks/${path.taskId}/runs/${path.runId}?workspace=${workspaceId}`, { method: "POST", headers });

describe("starting a queued run for the worker", () => {
  it("runs the member's own queued run in the app and answers with how it ended", async () => {
    const run = await queuedRun();
    try {
      const res = await start(run, alice.workspaceId, { Authorization: `Bearer ${alice.token}` });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await res.json()).toEqual({ status: "done", reason: "update" });
      const { data } = await alice.db.from("agent_task_runs").select("status, message_id").eq("id", run.runId).single();
      expect(data).toMatchObject({ status: "done" });
      expect(data!.message_id).toBeTruthy();
      // A run already started isn't started again.
      const again = await start(run, alice.workspaceId, { Authorization: `Bearer ${alice.token}` });
      expect(((await again.json()) as { status: string }).status).toBe("done");
    } finally {
      await alice.db.from("agent_records").delete().like("key", "https://jobs.example/%");
      await alice.db.from("agent_tasks").delete().eq("id", run.taskId);
    }
  }, 60_000);

  it("refuses without a member's token, and never runs another member's run", async () => {
    const run = await queuedRun();
    try {
      expect((await start(run, alice.workspaceId)).status).toBe(401);
      expect((await start(run, alice.workspaceId, { Authorization: "Bearer not-a-token" })).status).toBe(401);
      // Bob's token, whether he names Alice's workspace or his own.
      expect((await start(run, alice.workspaceId, { Authorization: `Bearer ${bob.token}` })).status).toBe(404);
      const own = await start(run, bob.workspaceId, { Authorization: `Bearer ${bob.token}` });
      expect(((await own.json()) as { status: string; reason: string }).reason).toBe("gone");
      const { data } = await alice.db.from("agent_task_runs").select("status").eq("id", run.runId).single();
      expect(data!.status).toBe("queued");
    } finally {
      await alice.db.from("agent_tasks").delete().eq("id", run.taskId);
    }
  }, 60_000);

  it("takes a token on this route only: every other API still needs a signed-in session", async () => {
    const auth = { Authorization: `Bearer ${alice.token}` };
    expect((await fetch(`${APP}/api/tasks`, { headers: auth })).status).toBe(401);
    expect((await fetch(`${APP}/api/workspace/settings`, { method: "PATCH", headers: auth, body: "{}" })).status).toBe(401);
    const run = await queuedRun();
    try {
      expect((await fetch(`${APP}/api/tasks/${run.taskId}/run`, { method: "POST", headers: auth })).status).toBe(401);
    } finally {
      await alice.db.from("agent_tasks").delete().eq("id", run.taskId);
    }
  });
});

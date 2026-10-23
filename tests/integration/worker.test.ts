import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { createAccount, createWorkspace, serviceClient, SUPABASE_ANON_KEY, SUPABASE_URL, type TestAccount } from "./helpers";

// The background worker's database surface: the worker_* functions only the service role may
// call, claiming due tasks exactly once per scheduled time however many dispatches race, and
// claim_run counting task runs apart from chat.

let alice: TestAccount;
let ws: string;
let admin: SupabaseClient;

const past = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function addTask(fields: Record<string, unknown> = {}): Promise<{ id: string; due: string }> {
  const due = past(5);
  const { data, error } = await alice.client
    .from("agent_tasks")
    .insert({ workspace_id: ws, title: "Check the job boards", schedule: { every: "hours", hours: 4 }, next_run_at: due, ...fields })
    .select("id, next_run_at")
    .single();
  expect(error).toBeNull();
  return { id: data!.id, due: data!.next_run_at };
}

type Claimed = { run_id: string; task_id: string; workspace_id: string; user_id: string; scheduled_for: string; run_status: string };

async function claim(): Promise<Claimed[]> {
  const { data, error } = await admin.rpc("worker_claim_due_tasks", { p_limit: 500 });
  expect(error).toBeNull();
  return data as Claimed[];
}

beforeAll(async () => {
  alice = await createAccount("worker-alice");
  ws = await createWorkspace(alice, "Worker Atelier");
  admin = await serviceClient();
});

describe("worker functions", () => {
  it("are refused to anon and to signed-in members", async () => {
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { id, due } = await addTask();
    for (const client of [anon, alice.client]) {
      const claimed = await client.rpc("worker_claim_due_tasks", { p_limit: 10 });
      expect(claimed.error?.code).toBe("42501");
      const moved = await client.rpc("worker_set_next_run", { p_task: id, p_due: due, p_next: new Date().toISOString() });
      expect(moved.error?.code).toBe("42501");
      const settled = await client.rpc("worker_settle_unstarted_run", { p_run: crypto.randomUUID(), p_status: "failed", p_reason: "not_started" });
      expect(settled.error?.code).toBe("42501");
    }
    const { data } = await alice.client.from("agent_task_runs").select("id").eq("task_id", id);
    expect(data).toEqual([]);
  });
});

describe("claiming due tasks", () => {
  it("records one run per task and time, however many dispatches race", async () => {
    const { id, due } = await addTask();
    const results = await Promise.all(Array.from({ length: 6 }, () => claim()));
    const ours = results.flat().filter((r) => r.task_id === id);
    expect(ours.length).toBeGreaterThan(0);
    expect(new Set(ours.map((r) => r.run_id)).size).toBe(1);
    expect(ours[0]).toMatchObject({ workspace_id: ws, user_id: alice.userId, run_status: "queued" });
    expect(Date.parse(ours[0].scheduled_for)).toBe(Date.parse(due));

    const { data: runs } = await alice.client.from("agent_task_runs").select("id, status").eq("task_id", id);
    expect(runs).toEqual([{ id: ours[0].run_id, status: "queued" }]);
  });

  it("returns the same run again until next_run_at moves on, then stops", async () => {
    const { id, due } = await addTask();
    const first = (await claim()).find((r) => r.task_id === id)!;
    const again = (await claim()).find((r) => r.task_id === id)!;
    expect(again.run_id).toBe(first.run_id);

    const next = new Date(Date.now() + 4 * 3600_000).toISOString();
    // Only from the time that was claimed: a member's change in between wins.
    const stale = await admin.rpc("worker_set_next_run", { p_task: id, p_due: past(60), p_next: next });
    expect(stale.data).toBe(false);
    const moved = await admin.rpc("worker_set_next_run", { p_task: id, p_due: due, p_next: next });
    expect(moved.data).toBe(true);

    expect((await claim()).some((r) => r.task_id === id)).toBe(false);
    const { data } = await alice.client.from("agent_tasks").select("next_run_at").eq("id", id).single();
    expect(Date.parse(data!.next_run_at)).toBe(Date.parse(next));
  });

  it("skips paused tasks and tasks that aren't due", async () => {
    const paused = await addTask({ status: "paused" });
    const later = await addTask({ next_run_at: new Date(Date.now() + 3600_000).toISOString() });
    const claimed = await claim();
    expect(claimed.some((r) => r.task_id === paused.id || r.task_id === later.id)).toBe(false);
  });
});

describe("settling a run the worker couldn't start", () => {
  it("records why on a queued run, and leaves a run the app began alone", async () => {
    const { id } = await addTask();
    const run = (await claim()).find((r) => r.task_id === id)!;
    const failed = await admin.rpc("worker_settle_unstarted_run", { p_run: run.run_id, p_status: "failed", p_reason: "not_started" });
    expect(failed.data).toBe(true);
    const { data } = await alice.client.from("agent_task_runs").select("status, reason").eq("id", run.run_id).single();
    expect(data).toEqual({ status: "failed", reason: "not_started" });

    // No longer queued: a second settle (or a late one after the app started it) changes nothing.
    const again = await admin.rpc("worker_settle_unstarted_run", { p_run: run.run_id, p_status: "skipped", p_reason: "member_unavailable" });
    expect(again.data).toBe(false);
  });

  it("refuses any status but skipped or failed", async () => {
    const { id } = await addTask();
    const run = (await claim()).find((r) => r.task_id === id)!;
    const refused = await admin.rpc("worker_settle_unstarted_run", { p_run: run.run_id, p_status: "done", p_reason: "x" });
    expect(refused.error?.code).toBe("22023");
  });
});

describe("claim_run kinds", () => {
  const limits = { p_concurrent: 1, p_per_minute: 50, p_per_day: 1000 };

  it("keeps task runs out of chat's concurrency, and chat out of theirs", async () => {
    const own = await createAccount("worker-kinds");
    const kindsWs = await createWorkspace(own, "Kinds");
    const conversation = crypto.randomUUID();
    expect((await own.client.from("conversations").insert({ id: conversation, workspace_id: kindsWs, title: "Task" })).error).toBeNull();

    // A task run claims a reply that's now streaming.
    const reply = crypto.randomUUID();
    const task = await own.client.rpc("claim_run", { ws: kindsWs, ...limits, p_message_id: reply, p_kind: "task_run" });
    expect(task.error).toBeNull();
    expect(task.data).toBeNull();
    const streaming = await own.client
      .from("messages")
      .insert({ id: reply, conversation_id: conversation, workspace_id: kindsWs, role: "assistant", content: "", status: "streaming" });
    expect(streaming.error).toBeNull();

    // Chat still has its one slot; a second task run doesn't.
    const chat = await own.client.rpc("claim_run", { ws: kindsWs, ...limits, p_message_id: crypto.randomUUID() });
    expect(chat.data).toBeNull();
    const second = await own.client.rpc("claim_run", { ws: kindsWs, ...limits, p_message_id: crypto.randomUUID(), p_kind: "task_run" });
    expect(second.data).toBe("concurrent");

    const { data: usage } = await own.client.from("usage_events").select("kind").eq("workspace_id", kindsWs).order("id");
    expect(usage!.map((u) => u.kind)).toEqual(["task_run", "agent_run"]);
  });

  it("counts each kind against its own daily cap", async () => {
    const own = await createAccount("worker-caps");
    const capsWs = await createWorkspace(own, "Caps");
    const run = (kind?: string) =>
      own.client.rpc("claim_run", { ws: capsWs, p_concurrent: 50, p_per_minute: 50, p_per_day: 1, ...(kind ? { p_kind: kind } : {}) });
    expect((await run("task_run")).data).toBeNull();
    expect((await run("task_run")).data).toBe("workspace_day");
    expect((await run()).data).toBeNull();
    expect((await run("agent_run")).data).toBe("workspace_day");
  });

  it("refuses an unknown kind", async () => {
    const refused = await alice.client.rpc("claim_run", { ws, ...limits, p_kind: "anything" });
    expect(refused.error).not.toBeNull();
  });
});

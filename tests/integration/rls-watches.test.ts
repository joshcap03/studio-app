import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { addMember, createAccount, createWorkspace, serviceClient, SUPABASE_ANON_KEY, SUPABASE_URL, type TestAccount } from "./helpers";

// Watches (docs/watches.md) are as private as the tasks they belong to, and an event reaches a
// run only through the claim functions: once per delivery, for the member Composio signed it
// for, folded into the task's waiting run, at most six runs an hour.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
let ws: string;
let bobWs: string;
let admin: SupabaseClient;
let aliceComposio: string;
let bobComposio: string;

type Claimed = { run_id: string; task_id: string; workspace_id: string; user_id: string; not_before: string; start_run: boolean };

async function composioIdOf(account: TestAccount): Promise<string> {
  const { data, error } = await account.client.rpc("ensure_account");
  expect(error).toBeNull();
  return (data as { composio_user_id: string }).composio_user_id;
}

/** One of Alice's tasks watching a trigger of hers. */
async function watchedTask(fields: Record<string, unknown> = {}): Promise<{ taskId: string; watchId: string; triggerId: string }> {
  const task = await alice.client.from("agent_tasks").insert({ workspace_id: ws, title: "Answer recruiters" }).select("id").single();
  expect(task.error).toBeNull();
  const triggerId = `ti_${crypto.randomUUID()}`;
  const watch = await alice.client
    .from("agent_task_watches")
    .insert({ task_id: task.data!.id, workspace_id: ws, toolkit: "gmail", trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE", composio_trigger_id: triggerId, status: "watching", ...fields })
    .select("id")
    .single();
  expect(watch.error).toBeNull();
  return { taskId: task.data!.id, watchId: watch.data!.id, triggerId };
}

const event = (id = `msg_${crypto.randomUUID()}`) => ({ id, at: new Date().toISOString(), summary: "New email from Dana Lee: Intro call?", data: { subject: "Intro call?" } });

async function claim(triggerId: string, composioUserId: string, eventId = `msg_${crypto.randomUUID()}`): Promise<Claimed | null> {
  const { data, error } = await admin.rpc("worker_claim_watch_event", {
    p_trigger_id: triggerId,
    p_composio_user_id: composioUserId,
    p_event_id: eventId,
    p_event: event(eventId),
  });
  expect(error).toBeNull();
  return ((data ?? []) as Claimed[])[0] ?? null;
}

beforeAll(async () => {
  alice = await createAccount("watches-alice");
  teammate = await createAccount("watches-mate");
  bob = await createAccount("watches-bob");
  ws = await createWorkspace(alice, "Watch Atelier");
  bobWs = await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, ws);
  admin = await serviceClient();
  aliceComposio = await composioIdOf(alice);
  bobComposio = await composioIdOf(bob);
});

// Each test starts under the ten-watch cap.
afterEach(async () => {
  await alice.client.from("agent_task_watches").delete().eq("workspace_id", ws);
});

describe("watches", () => {
  it("are private to their member, even from teammates", async () => {
    const { watchId } = await watchedTask();
    expect((await alice.client.from("agent_task_watches").select("id").eq("id", watchId)).data).toHaveLength(1);
    for (const other of [teammate, bob]) {
      expect((await other.client.from("agent_task_watches").select("id").eq("id", watchId)).data).toEqual([]);
      await other.client.from("agent_task_watches").update({ status: "paused" }).eq("id", watchId);
      await other.client.from("agent_task_watches").delete().eq("id", watchId);
    }
    const { data } = await alice.client.from("agent_task_watches").select("status").eq("id", watchId).single();
    expect(data).toEqual({ status: "watching" });
  });

  it("can't be put on someone else's task, or moved to another workspace", async () => {
    const theirs = await bob.client.from("agent_tasks").insert({ workspace_id: bobWs, title: "Bob's" }).select("id").single();
    const onTheirs = await alice.client
      .from("agent_task_watches")
      .insert({ task_id: theirs.data!.id, workspace_id: ws, toolkit: "gmail", trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" });
    expect(onTheirs.error).not.toBeNull();
    const asBob = await alice.client
      .from("agent_task_watches")
      .insert({ task_id: theirs.data!.id, workspace_id: bobWs, user_id: bob.userId, toolkit: "gmail", trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" });
    expect(asBob.error).not.toBeNull();

    const { watchId } = await watchedTask();
    const moved = await alice.client.from("agent_task_watches").update({ workspace_id: bobWs }).eq("id", watchId);
    expect(moved.error).not.toBeNull();
    const heard = await alice.client.from("agent_task_watches").update({ last_event_at: new Date().toISOString() }).eq("id", watchId);
    expect(heard.error).not.toBeNull();
  });

  it("keep their events to themselves, and members can't write them", async () => {
    const { watchId, triggerId } = await watchedTask();
    const eventId = `msg_${crypto.randomUUID()}`;
    expect(await claim(triggerId, aliceComposio, eventId)).not.toBeNull();
    expect((await alice.client.from("agent_watch_events").select("event_id").eq("watch_id", watchId)).data).toEqual([{ event_id: eventId }]);
    for (const other of [teammate, bob]) expect((await other.client.from("agent_watch_events").select("event_id").eq("watch_id", watchId)).data).toEqual([]);
    const forged = await alice.client.from("agent_watch_events").insert({ watch_id: watchId, workspace_id: ws, user_id: alice.userId, event_id: "msg_forged" });
    expect(forged.error).not.toBeNull();
  });
});

describe("claiming a watch's events", () => {
  it("is refused to anon and to members", async () => {
    const { triggerId } = await watchedTask();
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    for (const client of [anon, alice.client]) {
      const res = await client.rpc("worker_claim_watch_event", { p_trigger_id: triggerId, p_composio_user_id: aliceComposio, p_event_id: "msg_x", p_event: event() });
      expect(res.error?.code).toBe("42501");
      const inner = await client.rpc("claim_watch_event", { p_watch: crypto.randomUUID(), p_event_id: "msg_x", p_event: event(), p_wait: "0 seconds" });
      expect(inner.error).not.toBeNull();
    }
  });

  it("starts a run that waits for more, and folds the next events into it", async () => {
    const { taskId, triggerId } = await watchedTask();
    const first = await claim(triggerId, aliceComposio);
    expect(first).toMatchObject({ task_id: taskId, workspace_id: ws, user_id: alice.userId, start_run: true });
    expect(Date.parse(first!.not_before)).toBeGreaterThan(Date.now() + 30_000);
    const second = await claim(triggerId, aliceComposio);
    expect(second).toMatchObject({ run_id: first!.run_id, start_run: false });

    const { data } = await alice.client.from("agent_task_runs").select("status, events, more_events").eq("task_id", taskId);
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({ status: "queued", more_events: 0 });
    expect(data![0].events).toHaveLength(2);
  });

  it("takes each delivery once, and hands back its run only while it's still queued", async () => {
    const { taskId, triggerId } = await watchedTask();
    const eventId = `msg_${crypto.randomUUID()}`;
    const first = await claim(triggerId, aliceComposio, eventId);
    const again = await claim(triggerId, aliceComposio, eventId);
    expect(again).toMatchObject({ run_id: first!.run_id, start_run: true });
    const { data } = await alice.client.from("agent_task_runs").select("events").eq("task_id", taskId).single();
    expect(data!.events).toHaveLength(1);

    await alice.client.from("agent_task_runs").update({ status: "running" }).eq("id", first!.run_id);
    expect(await claim(triggerId, aliceComposio, eventId)).toBeNull();
  });

  it("takes nothing for someone else's trigger, a watch that's off, or a task that isn't active", async () => {
    const { triggerId } = await watchedTask();
    // Bob attaching Alice's trigger id gets him nothing: the event is signed for Alice.
    const bobTask = await bob.client.from("agent_tasks").insert({ workspace_id: bobWs, title: "Bob's" }).select("id").single();
    const squat = await bob.client
      .from("agent_task_watches")
      .insert({ task_id: bobTask.data!.id, workspace_id: bobWs, toolkit: "gmail", trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE", composio_trigger_id: `ti_${crypto.randomUUID()}`, status: "watching" })
      .select("composio_trigger_id")
      .single();
    expect(squat.error).toBeNull();
    expect(await claim(squat.data!.composio_trigger_id, aliceComposio)).toBeNull();
    expect(await claim(triggerId, bobComposio)).toBeNull();
    expect(await claim(`ti_${crypto.randomUUID()}`, aliceComposio)).toBeNull();

    const paused = await watchedTask({ status: "paused" });
    expect(await claim(paused.triggerId, aliceComposio)).toBeNull();
    const idle = await watchedTask();
    await alice.client.from("agent_tasks").update({ status: "paused" }).eq("id", idle.taskId);
    expect(await claim(idle.triggerId, aliceComposio)).toBeNull();
  });

  it("holds 20 events in a run and counts the rest", async () => {
    const { taskId, triggerId } = await watchedTask();
    for (let i = 0; i < 23; i++) await claim(triggerId, aliceComposio);
    const { data } = await alice.client.from("agent_task_runs").select("events, more_events").eq("task_id", taskId);
    expect(data).toHaveLength(1);
    expect(data![0].events).toHaveLength(20);
    expect(data![0].more_events).toBe(3);
  });

  it("gives a watch at most six runs an hour: a seventh waits", async () => {
    const { taskId, triggerId } = await watchedTask();
    for (let i = 0; i < 6; i++) {
      const claimed = await claim(triggerId, aliceComposio);
      // Each run starts, so the next event can't fold into it.
      await alice.client.from("agent_task_runs").update({ status: "done" }).eq("id", claimed!.run_id);
    }
    const seventh = await claim(triggerId, aliceComposio);
    expect(seventh!.start_run).toBe(true);
    expect(Date.parse(seventh!.not_before)).toBeGreaterThan(Date.now() + 50 * 60_000);
    const { count } = await alice.client.from("agent_task_runs").select("id", { count: "exact", head: true }).eq("task_id", taskId);
    expect(count).toBe(7);
  });

  it("lets a member try only their own watch", async () => {
    const { watchId, taskId } = await watchedTask();
    const own = await alice.client.rpc("claim_own_watch_event", { p_watch: watchId, p_event_id: "test_1", p_event: event("test_1"), p_wait_seconds: 0 });
    expect(own.error).toBeNull();
    expect((own.data as Claimed[])[0]).toMatchObject({ task_id: taskId, start_run: true });
    for (const other of [teammate, bob]) {
      const theirs = await other.client.rpc("claim_own_watch_event", { p_watch: watchId, p_event_id: "test_2", p_event: event("test_2") });
      expect(theirs.error?.code).toBe("42501");
    }
  });

  it("refuses an event too large to carry", async () => {
    const { triggerId } = await watchedTask();
    const res = await admin.rpc("worker_claim_watch_event", {
      p_trigger_id: triggerId,
      p_composio_user_id: aliceComposio,
      p_event_id: "msg_big",
      p_event: { ...event("msg_big"), data: { text: "x".repeat(10_000) } },
    });
    expect(res.error?.code).toBe("22023");
  });

  it("keeps a member to ten watches", async () => {
    const solo = await createAccount("watches-cap");
    const soloWs = await createWorkspace(solo, "Cap");
    const tasks = await solo.client
      .from("agent_tasks")
      .insert(Array.from({ length: 11 }, (_, i) => ({ workspace_id: soloWs, title: `Task ${i}` })))
      .select("id");
    expect(tasks.error).toBeNull();
    for (const [i, t] of tasks.data!.entries()) {
      const res = await solo.client.from("agent_task_watches").insert({ task_id: t.id, workspace_id: soloWs, toolkit: "gmail", trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" });
      if (i < 10) expect(res.error).toBeNull();
      else expect(res.error?.hint).toBe("watch_limit");
    }
  });
});

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./helpers";

// Tasks and records through the app's HTTP API: each member reaches only their own, a forged
// workspace cookie changes nothing, and ids from another tenant read as missing. Alice and Bob
// are fixed accounts reused across runs on the local stack.
// Requires the QA server (mock agent) on APP_URL.

const APP = process.env.APP_URL ?? "http://127.0.0.1:3100";
/** What the mock agent's "track" run says done means (src/lib/agent/mock.ts). */
const MOCK_GOAL = "two roles worth your time in your tracker, with outreach drafted (demo)";
const PASSWORD = "pw-local-tasks-api-only";

class Client {
  private cookies = new Map<string, string>();

  async json(path: string, method: string, body?: unknown, extraCookies: Record<string, string> = {}): Promise<Response> {
    const jar = new Map([...this.cookies, ...Object.entries(extraCookies)]);
    const res = await fetch(APP + path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      headers: {
        Origin: APP,
        "Content-Type": "application/json",
        Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
      },
    });
    for (const header of res.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const index = pair.indexOf("=");
      const value = pair.slice(index + 1);
      if (value === "" || /max-age=0/i.test(header)) this.cookies.delete(pair.slice(0, index));
      else this.cookies.set(pair.slice(0, index), value);
    }
    return res;
  }
}

interface Member {
  api: Client;
  db: SupabaseClient;
  workspaceId: string;
}

/** Signs in (or up, the first time) through the app and directly, and finds or makes a workspace. */
async function member(email: string, password = PASSWORD): Promise<Member> {
  const api = new Client();
  if ((await api.json("/api/auth/signin", "POST", { email, password })).status !== 200) {
    const res = await api.json("/api/auth/signup", "POST", { email, password });
    expect(res.status, await res.clone().text()).toBe(200);
  }
  const listed = (await (await api.json("/api/workspaces", "GET")).json()) as { workspaces: { id: string }[]; active: string | null };
  let workspaceId = listed.active;
  if (!workspaceId) {
    const res = await api.json("/api/workspaces", "POST", { name: `${email.split("@")[0]} space` });
    expect(res.status).toBe(201);
    workspaceId = ((await res.json()) as { workspaceId: string }).workspaceId;
  }
  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  expect((await db.auth.signInWithPassword({ email, password })).error).toBeNull();
  return { api, db, workspaceId };
}

let alice: Member;
let bob: Member;
let aliceTask: string;
let aliceRecord: string;
let aliceSkill: string;
const aliceConv = crypto.randomUUID();
const collection = `jobs-${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  const health = await fetch(`${APP}/login`).catch(() => null);
  if (!health) throw new Error(`QA server not reachable at ${APP}; run npm run qa:serve`);
  alice = await member("tasks-api-alice@example.test");
  bob = await member("tasks-api-bob@example.test");

  const created = await alice.api.json("/api/tasks", "POST", {
    title: "Find design jobs",
    instructions: "alice-secret-goal",
    schedule: { every: "weekdays", at: "08:00" },
    timezone: "America/New_York",
    plan: [{ id: "a", text: "Search boards", status: "doing" }],
  });
  expect(created.status, await created.clone().text()).toBe(201);
  aliceTask = ((await created.json()) as { task: { id: string } }).task.id;

  const userId = (await alice.db.auth.getUser()).data.user!.id;
  expect((await alice.db.from("conversations").insert({ id: aliceConv, workspace_id: alice.workspaceId, title: "Alice private" })).error).toBeNull();
  const skill = await alice.db
    .from("workspace_skills")
    .insert({ workspace_id: alice.workspaceId, name: `Scout ${collection}`, instructions: "Find.", created_by: userId })
    .select("id")
    .single();
  expect(skill.error).toBeNull();
  aliceSkill = skill.data!.id;
  expect(
    (await alice.db.from("agent_task_runs").insert({ task_id: aliceTask, workspace_id: alice.workspaceId, scheduled_for: new Date().toISOString() }))
      .error,
  ).toBeNull();
  const record = await alice.db
    .from("agent_records")
    .insert({ workspace_id: alice.workspaceId, collection, key: "https://jobs.example.test/1", title: "alice-secret-job" })
    .select("id")
    .single();
  expect(record.error).toBeNull();
  aliceRecord = record.data!.id;
}, 60_000);

afterAll(async () => {
  await alice?.api.json(`/api/tasks/${aliceTask}`, "DELETE");
  await alice?.db.from("agent_records").delete().eq("collection", collection);
  await alice?.db.from("workspace_skills").delete().eq("id", aliceSkill);
  await alice?.db.from("conversations").delete().eq("id", aliceConv);
  for (const m of [alice, bob]) {
    const left = (await (await m?.api.json("/api/tasks", "GET"))?.json()) as { tasks?: { id: string; title: string }[] } | undefined;
    for (const t of left?.tasks ?? []) if (t.title.startsWith("Bob ")) await m.api.json(`/api/tasks/${t.id}`, "DELETE");
  }
});

describe("tasks API", () => {
  it("is on for every account, starting empty", async () => {
    const newcomer = await member(`tasks-newcomer-${crypto.randomUUID().slice(0, 8)}@example.test`, `pw-${crypto.randomUUID()}`);
    const tasks = await newcomer.api.json("/api/tasks", "GET");
    expect(tasks.status).toBe(200);
    expect(((await tasks.json()) as { tasks: unknown[] }).tasks).toEqual([]);
    expect((await newcomer.api.json("/api/records", "GET")).status).toBe(200);
  });

  it("serves the owner their task, plan, and runs", async () => {
    const got = (await (await alice.api.json(`/api/tasks/${aliceTask}`, "GET")).json()) as {
      task: { instructions: string; schedule: unknown; plan: { status: string }[]; status: string; nextRunAt: number | null };
    };
    expect(got.task).toMatchObject({ instructions: "alice-secret-goal", schedule: { every: "weekdays", at: "08:00" }, status: "active" });
    expect(got.task.nextRunAt).toBeGreaterThan(Date.now());
    const patched = await alice.api.json(`/api/tasks/${aliceTask}`, "PATCH", {
      status: "paused",
      plan: [{ id: "a", text: "Search boards", status: "done", note: "Found 3" }],
      goal: "  three design roles   worth applying to ",
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { task: { status: string; nextRunAt: number | null; goal: string | null } }).task).toMatchObject({
      status: "paused",
      nextRunAt: null,
      goal: "three design roles worth applying to",
    });
    // Cleared by an empty line; Bob can't change it.
    expect((await bob.api.json(`/api/tasks/${aliceTask}`, "PATCH", { goal: "forged" })).status).toBe(404);
    const cleared = (await (await alice.api.json(`/api/tasks/${aliceTask}`, "PATCH", { goal: "" })).json()) as { task: { goal: string | null } };
    expect(cleared.task.goal).toBeNull();
    const runs = (await (await alice.api.json(`/api/tasks/${aliceTask}/runs`, "GET")).json()) as { runs: { status: string }[] };
    expect(runs.runs.map((r) => r.status)).toEqual(["queued"]);
  });

  it("rejects malformed tasks", async () => {
    for (const body of [
      { title: "" },
      { title: "x", schedule: { every: "fortnight" } },
      { title: "x", timezone: "Mars/Olympus" },
      { title: "x", plan: [{ id: "a", text: "x", status: "maybe" }] },
      { title: "x", workspaceId: bob.workspaceId },
      { title: "x", userId: crypto.randomUUID() },
    ]) {
      expect((await alice.api.json("/api/tasks", "POST", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await alice.api.json(`/api/tasks/${aliceTask}`, "PATCH", {})).status).toBe(400);
    expect((await alice.api.json(`/api/tasks/${aliceTask}`, "PATCH", { goal: "x".repeat(201) })).status).toBe(400);
    expect((await alice.api.json(`/api/tasks/${aliceTask}`, "PATCH", { templateTaskId: "x" })).status).toBe(400);
  });

  it("returns 404 for another tenant's task on every verb, even with a forged workspace cookie", async () => {
    for (const cookies of [{}, { lj_ws: alice.workspaceId }] as Record<string, string>[]) {
      const list = (await (await bob.api.json("/api/tasks", "GET", undefined, cookies)).json()) as { tasks: { id: string }[] };
      expect(list.tasks.map((t) => t.id)).not.toContain(aliceTask);
      expect((await bob.api.json(`/api/tasks/${aliceTask}`, "GET", undefined, cookies)).status).toBe(404);
      expect((await bob.api.json(`/api/tasks/${aliceTask}`, "PATCH", { title: "pwned" }, cookies)).status).toBe(404);
      expect((await bob.api.json(`/api/tasks/${aliceTask}/runs`, "GET", undefined, cookies)).status).toBe(404);
      expect((await bob.api.json(`/api/tasks/${aliceTask}`, "DELETE", undefined, cookies)).status).toBe(404);
    }
    const still = (await (await alice.api.json(`/api/tasks/${aliceTask}`, "GET")).json()) as { task: { title: string } };
    expect(still.task.title).toBe("Find design jobs");
  });

  it("won't link a task to another tenant's conversation or skill", async () => {
    expect((await bob.api.json("/api/tasks", "POST", { title: "Bob steal", conversationId: aliceConv })).status).toBe(400);
    expect((await bob.api.json("/api/tasks", "POST", { title: "Bob steal", skillId: aliceSkill })).status).toBe(400);
    const own = await bob.api.json("/api/tasks", "POST", { title: "Bob own" });
    expect(own.status).toBe(201);
    const id = ((await own.json()) as { task: { id: string } }).task.id;
    expect((await bob.api.json(`/api/tasks/${id}`, "PATCH", { conversationId: aliceConv })).status).toBe(400);
    expect((await bob.api.json(`/api/tasks/${id}`, "DELETE")).status).toBe(204);
  });
});

describe("records API", () => {
  it("lists the owner's records, by collection", async () => {
    const mine = (await (await alice.api.json(`/api/records?collection=${collection}`, "GET")).json()) as { records: { id: string }[] };
    expect(mine.records.map((r) => r.id)).toEqual([aliceRecord]);
    expect((await alice.api.json("/api/records?collection=Not%20a%20slug", "GET")).status).toBe(400);
    const patched = await alice.api.json(`/api/records/${aliceRecord}`, "PATCH", { status: "applied", fields: { salary: "120k" } });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { record: { status: string } }).record.status).toBe("applied");
    expect((await alice.api.json(`/api/records/${aliceRecord}`, "PATCH", { url: "javascript:alert(1)" })).status).toBe(400);
  });

  it("hides and protects records from another tenant", async () => {
    for (const cookies of [{}, { lj_ws: alice.workspaceId }] as Record<string, string>[]) {
      const theirs = (await (await bob.api.json(`/api/records?collection=${collection}`, "GET", undefined, cookies)).json()) as {
        records: unknown[];
      };
      expect(theirs.records).toEqual([]);
      expect((await bob.api.json(`/api/records/${aliceRecord}`, "PATCH", { title: "pwned" }, cookies)).status).toBe(404);
      expect((await bob.api.json(`/api/records/${aliceRecord}`, "DELETE", undefined, cookies)).status).toBe(404);
      // Nor does her tracker show up in Bob's Library.
      const library = (await (await bob.api.json("/api/library", "GET", undefined, cookies)).json()) as { trackers: { collection: string }[] };
      expect(library.trackers.map((t) => t.collection)).not.toContain(collection);
    }
    const summary = (await (await alice.api.json("/api/library", "GET")).json()) as { trackers: { collection: string; count: number }[] };
    expect(summary.trackers.find((t) => t.collection === collection)).toMatchObject({ count: 1 });
    const kept = (await (await alice.api.json(`/api/records?collection=${collection}`, "GET")).json()) as { records: { title: string }[] };
    expect(kept.records.map((r) => r.title)).toEqual(["alice-secret-job"]);
  });
});

describe("adding a row", () => {
  it("adds the member's own row under a key of its own, in their tracker only", async () => {
    const sheet = `${collection}-own`;
    const res = await alice.api.json("/api/records", "POST", { collection: sheet, title: "Typed by hand", fields: { pay: "$1" } });
    expect(res.status).toBe(201);
    const { record } = (await res.json()) as { record: { id: string; key: string; title: string } };
    expect(record).toMatchObject({ title: "Typed by hand", key: expect.stringMatching(/^member-/) });
    expect((await alice.api.json("/api/records", "POST", { collection: sheet, title: "x", key: "job-1" })).status).toBe(400);
    expect((await alice.api.json("/api/records", "POST", { collection: "Not a slug", title: "x" })).status).toBe(400);
    const theirs = (await (await bob.api.json(`/api/records?collection=${sheet}`, "GET")).json()) as { records: unknown[] };
    expect(theirs.records).toEqual([]);
    await alice.db.from("agent_records").delete().eq("collection", sheet);
  });
});

describe("running a task", () => {
  it("runs the brief in the task's own conversation and saves the plan and tracker rows the agent reports", async () => {
    // The mock agent's "roles" run reports a plan and two tracker rows.
    const created = await alice.api.json("/api/tasks", "POST", { title: "Scout roles", instructions: "Find roles that fit." });
    expect(created.status).toBe(201);
    const taskId = ((await created.json()) as { task: { id: string } }).task.id;
    try {
      expect((await bob.api.json(`/api/tasks/${taskId}/run`, "POST")).status).toBe(404);
      expect((await bob.api.json(`/api/tasks/${taskId}/run`, "POST", undefined, { lj_ws: alice.workspaceId })).status).toBe(404);

      const started = await alice.api.json(`/api/tasks/${taskId}/run`, "POST");
      expect(started.status, await started.clone().text()).toBe(202);
      const { conversationId, runId } = (await started.json()) as { conversationId: string; runId: string };

      let messages: { role: string; status: string; origin?: { kind: string; taskId: string } | null }[] = [];
      for (let i = 0; i < 60 && messages.at(-1)?.status !== "complete"; i++) {
        await new Promise((r) => setTimeout(r, 500));
        messages = ((await (await alice.api.json(`/api/conversations/${conversationId}`, "GET")).json()) as { messages: typeof messages }).messages;
      }
      expect(messages.map((m) => [m.role, m.status])).toEqual([
        ["user", "complete"],
        ["assistant", "complete"],
      ]);
      expect(messages[0].origin).toMatchObject({ kind: "task", taskId });

      const task = ((await (await alice.api.json(`/api/tasks/${taskId}`, "GET")).json()) as {
        task: { conversationId: string; plan: { text: string; status: string }[]; goal: string | null; lastRunAt: number | null };
      }).task;
      expect(task.conversationId).toBe(conversationId);
      // The later of its two plan updates, with the goal the first one gave.
      expect(task.plan.map((s) => s.status)).toEqual(["done", "doing", "todo"]);
      expect(task.goal).toBe(MOCK_GOAL);
      // The task's conversation shows the task's plan.
      const thread = (await (await alice.api.json(`/api/conversations/${conversationId}`, "GET")).json()) as { journey: { kind: string; goal: string | null } | null };
      expect(thread.journey).toMatchObject({ kind: "task", goal: MOCK_GOAL });
      expect(task.lastRunAt).not.toBeNull();

      const runs = ((await (await alice.api.json(`/api/tasks/${taskId}/runs`, "GET")).json()) as {
        runs: { id: string; status: string; reason: string | null }[];
      }).runs;
      expect(runs.find((r) => r.id === runId)).toMatchObject({ status: "done", reason: "update" });

      const tracked = ((await (await alice.api.json("/api/records?collection=applications", "GET")).json()) as {
        records: { key: string; taskId: string | null }[];
      }).records.filter((r) => r.key.startsWith("https://jobs.example/"));
      expect(tracked.map((r) => r.taskId)).toEqual([taskId, taskId]);
      const bobs = (await (await bob.api.json("/api/records?collection=applications", "GET")).json()) as { records: { taskId: string | null }[] };
      expect(bobs.records.some((r) => r.taskId === taskId)).toBe(false);
    } finally {
      await alice.db.from("agent_records").delete().eq("collection", "applications").like("key", "https://jobs.example/%");
      await alice.api.json(`/api/tasks/${taskId}`, "DELETE");
    }
  }, 60_000);
});

describe("a plan in any conversation", () => {
  type Journey = { kind: string; goal: string | null; steps: { text: string; status: string }[] };

  it("keeps the plan and goal the agent reports, live and on reload, for its member only", async () => {
    // The mock agent's "track" run says what done means, plans, searches, then updates the plan.
    const conversationId = crypto.randomUUID();
    try {
      const res = await alice.api.json(`/api/conversations/${conversationId}/messages`, "POST", { kind: "send", text: "Track a few roles for me" });
      expect(res.status, await res.clone().text()).toBe(200);
      const events = (await res.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; journey?: Journey });
      const journeys = events.filter((e) => e.type === "journey").map((e) => e.journey!);
      expect(journeys.map((j) => j.steps.map((s) => s.status))).toEqual([
        ["doing", "todo", "todo"],
        ["done", "doing", "todo"],
      ]);
      for (const j of journeys) expect(j).toMatchObject({ kind: "conversation", goal: MOCK_GOAL });
      // Before the reply ends.
      expect(events.findIndex((e) => e.type === "journey")).toBeLessThan(events.findIndex((e) => e.type === "end"));

      const got = (await (await alice.api.json(`/api/conversations/${conversationId}`, "GET")).json()) as { journey: Journey | null };
      expect(got.journey).toMatchObject({ kind: "conversation", goal: MOCK_GOAL, steps: journeys[1].steps });
      expect((await bob.api.json(`/api/conversations/${conversationId}`, "GET")).status).toBe(404);
      // In the list, conversations carry no plan.
      const listed = (await (await alice.api.json("/api/conversations", "GET")).json()) as { conversations: Record<string, unknown>[] };
      expect(Object.keys(listed.conversations.find((c) => c.id === conversationId) ?? {})).not.toContain("goal");

      // The member can clear it; no one else can.
      expect((await bob.api.json(`/api/conversations/${conversationId}`, "PATCH", { plan: null })).status).toBe(404);
      expect(((await (await alice.api.json(`/api/conversations/${conversationId}`, "GET")).json()) as { journey: Journey | null }).journey).not.toBeNull();
      expect((await alice.api.json(`/api/conversations/${conversationId}`, "PATCH", { plan: [] })).status).toBe(400);
      const cleared = await alice.api.json(`/api/conversations/${conversationId}`, "PATCH", { plan: null });
      expect(cleared.status, await cleared.clone().text()).toBe(200);
      expect(((await cleared.json()) as { conversation: { id: string } }).conversation.id).toBe(conversationId);
      expect(((await (await alice.api.json(`/api/conversations/${conversationId}`, "GET")).json()) as { journey: Journey | null }).journey).toBeNull();
      expect((await alice.db.from("conversations").select("plan, goal").eq("id", conversationId).single()).data).toEqual({ plan: [], goal: null });
      expect((await alice.api.json(`/api/conversations/${crypto.randomUUID()}`, "PATCH", { plan: null })).status).toBe(404);
    } finally {
      await alice.db.from("agent_records").delete().eq("collection", "applications").like("key", "https://jobs.example/%");
      await alice.api.json(`/api/conversations/${conversationId}`, "DELETE");
    }
  }, 60_000);

  it("says whose move it is, only for the caller's own conversations", async () => {
    // The mock's form leaves it the member's call; a finished reply needs no mark.
    const asking = crypto.randomUUID();
    try {
      await (await alice.api.json(`/api/conversations/${asking}/messages`, "POST", { kind: "send", text: "show me a form" })).text();
      const ids = [asking, aliceConv, crypto.randomUUID()].join(",");
      const mine = (await (await alice.api.json(`/api/conversations/moves?ids=${ids}`, "GET")).json()) as { moves: Record<string, string> };
      expect(mine.moves).toEqual({ [asking]: "your_call" });
      const theirs = await bob.api.json(`/api/conversations/moves?ids=${ids}`, "GET");
      expect(theirs.status).toBe(200);
      expect(((await theirs.json()) as { moves: Record<string, string> }).moves).toEqual({});
      // A forged workspace cookie changes nothing.
      expect(((await (await bob.api.json(`/api/conversations/moves?ids=${ids}`, "GET", undefined, { lj_ws: alice.workspaceId })).json()) as { moves: unknown }).moves).toEqual({});
      expect((await alice.api.json("/api/conversations/moves?ids=not-an-id", "GET")).status).toBe(400);
      const many = Array.from({ length: 101 }, () => crypto.randomUUID()).join(",");
      expect((await alice.api.json(`/api/conversations/moves?ids=${many}`, "GET")).status).toBe(400);
      expect(((await (await alice.api.json("/api/conversations/moves", "GET")).json()) as { moves: unknown }).moves).toEqual({});
    } finally {
      await alice.api.json(`/api/conversations/${asking}`, "DELETE");
    }
  }, 60_000);
});

describe("applying a template", () => {
  const JOB_TASKS = ["find-new-roles", "check-replies", "weekly-pipeline-review", "interview-prep"];
  type Seeded = { id: string; templateTaskId: string | null; status: string; nextRunAt: number | null; timezone: string; skillId: string | null };
  const seeded = async (m: Member) =>
    ((await (await m.api.json("/api/tasks", "GET")).json()) as { tasks: Seeded[] }).tasks.filter((t) => JOB_TASKS.includes(t.templateTaskId ?? ""));

  it("gives the member the template's tasks, paused, once", async () => {
    for (const t of await seeded(alice)) await alice.api.json(`/api/tasks/${t.id}`, "DELETE");
    try {
      const first = await alice.api.json("/api/workspace/template", "POST", { templateId: "job-search", timezone: "America/New_York" });
      expect(first.status, await first.clone().text()).toBe(200);
      expect(((await first.json()) as { addedTasks: number }).addedTasks).toBe(JOB_TASKS.length);
      const tasks = await seeded(alice);
      expect(tasks.map((t) => t.templateTaskId).sort()).toEqual([...JOB_TASKS].sort());
      for (const t of tasks) expect(t).toMatchObject({ status: "paused", nextRunAt: null, timezone: "America/New_York" });
      // The task's skill is the workspace's copy of the library skill.
      const findRoles = tasks.find((t) => t.templateTaskId === "find-new-roles")!;
      const skill = await alice.db.from("workspace_skills").select("catalog_id").eq("id", findRoles.skillId!).single();
      expect(skill.data?.catalog_id).toBe("find-roles");

      const again = await alice.api.json("/api/workspace/template", "POST", { templateId: "job-search" });
      expect(((await again.json()) as { addedTasks: number }).addedTasks).toBe(0);
      expect((await seeded(alice)).length).toBe(JOB_TASKS.length);
      // Nobody else gets them.
      expect((await seeded(bob)).length).toBe(0);
    } finally {
      for (const t of await seeded(alice)) await alice.api.json(`/api/tasks/${t.id}`, "DELETE");
    }
  });

  it("gives a new agent made from a template its skills and paused tasks", async () => {
    const newcomer = await member(`tasks-newcomer-${crypto.randomUUID().slice(0, 8)}@example.test`, `pw-${crypto.randomUUID()}`);
    const res = await newcomer.api.json("/api/workspaces", "POST", { name: "Job hunt", templateId: "job-search", timezone: "Europe/London" });
    expect(res.status, await res.clone().text()).toBe(201);
    const workspaceId = ((await res.json()) as { workspaceId: string }).workspaceId;
    const skills = await newcomer.db.from("workspace_skills").select("catalog_id").eq("workspace_id", workspaceId);
    expect(skills.data?.map((s) => s.catalog_id)).toContain("find-roles");
    const tasks = await newcomer.db.from("agent_tasks").select("status").eq("workspace_id", workspaceId);
    expect(tasks.error).toBeNull();
    expect(tasks.data?.length).toBe(JOB_TASKS.length);
    for (const t of tasks.data ?? []) expect(t.status).toBe("paused");
  });
});

describe("a quiet task run", () => {
  it("records that it found nothing new", async () => {
    const created = await alice.api.json("/api/tasks", "POST", { title: "Inbox watch", instructions: "Check for replies; report if nothing new." });
    const taskId = ((await created.json()) as { task: { id: string } }).task.id;
    try {
      const started = await alice.api.json(`/api/tasks/${taskId}/run`, "POST");
      expect(started.status).toBe(202);
      const { runId } = (await started.json()) as { runId: string };
      let run: { status: string; reason: string | null } | undefined;
      for (let i = 0; i < 60 && run?.status !== "done"; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const runs = ((await (await alice.api.json(`/api/tasks/${taskId}/runs`, "GET")).json()) as { runs: { id: string; status: string; reason: string | null }[] }).runs;
        run = runs.find((r) => r.id === runId);
      }
      expect(run).toMatchObject({ status: "done", reason: "nothing_new" });
    } finally {
      await alice.api.json(`/api/tasks/${taskId}`, "DELETE");
    }
  }, 60_000);
});

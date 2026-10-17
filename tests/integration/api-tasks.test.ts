import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./helpers";

// Tasks and records through the app's HTTP API: each member reaches only their own, a forged
// workspace cookie changes nothing, and ids from another tenant read as missing. The routes
// are a preview feature, so Alice and Bob are fixed accounts the QA server allowlists
// (PREVIEW_FEATURE_EMAILS in `npm run qa:serve`); they're reused across runs on the local stack.
// Requires the QA server (mock agent) on APP_URL.

const APP = process.env.APP_URL ?? "http://127.0.0.1:3100";
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
  it("is off for accounts without the preview", async () => {
    const outsider = await member(`tasks-outsider-${crypto.randomUUID().slice(0, 8)}@example.test`, `pw-${crypto.randomUUID()}`);
    expect((await outsider.api.json("/api/tasks", "GET")).status).toBe(404);
    expect((await outsider.api.json("/api/tasks", "POST", { title: "x" })).status).toBe(404);
    expect((await outsider.api.json("/api/records", "GET")).status).toBe(404);
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
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { task: { status: string; nextRunAt: number | null } }).task).toMatchObject({
      status: "paused",
      nextRunAt: null,
    });
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
    }
    const kept = (await (await alice.api.json(`/api/records?collection=${collection}`, "GET")).json()) as { records: { title: string }[] };
    expect(kept.records.map((r) => r.title)).toEqual(["alice-secret-job"]);
  });
});

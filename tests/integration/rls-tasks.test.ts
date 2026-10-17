import { beforeAll, describe, expect, it } from "vitest";
import { appendRun } from "@/lib/tasks";
import { upsertRecord } from "@/lib/tasks/records";
import type { Tenant } from "@/lib/tenant";
import { addMember, createAccount, createWorkspace, type TestAccount } from "./helpers";

// Tasks, their runs, and the records the agent keeps are as private as the member's chats:
// invisible to teammates and other tenants, and nobody can point their own task, run, or
// record at someone else's conversation, skill, task, or message.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
let ws: string;
let bobWs: string;
let skill: string;
let message: string;
const conversation = crypto.randomUUID();
const task = crypto.randomUUID();
const run = crypto.randomUUID();
const record = crypto.randomUUID();

const step = (id: string, status = "todo") => ({ id, text: `Step ${id}`, status, note: null });

beforeAll(async () => {
  alice = await createAccount("tasks-alice");
  teammate = await createAccount("tasks-mate");
  bob = await createAccount("tasks-bob");
  ws = await createWorkspace(alice, "Task Atelier");
  bobWs = await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, ws);

  const added = await alice.client
    .from("workspace_skills")
    .insert({ workspace_id: ws, name: "Scout", instructions: "Find openings.", created_by: alice.userId })
    .select("id")
    .single();
  expect(added.error).toBeNull();
  skill = added.data!.id;
  expect((await alice.client.from("conversations").insert({ id: conversation, workspace_id: ws, title: "Job hunt" })).error).toBeNull();
  const sent = await alice.client
    .from("messages")
    .insert({
      conversation_id: conversation,
      workspace_id: ws,
      role: "assistant",
      content: "Found two openings.",
      status: "complete",
      origin: { kind: "task", taskId: task, runId: run },
    })
    .select("id")
    .single();
  expect(sent.error).toBeNull();
  message = sent.data!.id;

  expect(
    (
      await alice.client.from("agent_tasks").insert({
        id: task,
        workspace_id: ws,
        title: "Find design jobs",
        instructions: "alice-secret-goal",
        skill_id: skill,
        schedule: { every: "weekdays", at: "08:00" },
        timezone: "America/New_York",
        plan: [step("a", "done"), step("b", "doing")],
        conversation_id: conversation,
        template_task_id: "job-search-daily",
      })
    ).error,
  ).toBeNull();
  expect(
    (
      await alice.client.from("agent_task_runs").insert({
        id: run,
        task_id: task,
        workspace_id: ws,
        scheduled_for: "2026-10-20T12:00:00Z",
        message_id: message,
      })
    ).error,
  ).toBeNull();
  expect(
    (
      await alice.client.from("agent_records").insert({
        id: record,
        workspace_id: ws,
        collection: "job-applications",
        key: "https://jobs.example.test/1",
        title: "alice-secret-job",
        status: "applied",
        url: "https://jobs.example.test/1",
        fields: { company: "Example" },
        task_id: task,
        source_message_id: message,
      })
    ).error,
  ).toBeNull();
});

describe("agent tasks, runs, and records", () => {
  it("are visible only to the member who owns them", async () => {
    expect((await alice.client.from("agent_tasks").select("instructions").eq("id", task).single()).data?.instructions).toBe(
      "alice-secret-goal",
    );
    expect((await alice.client.from("agent_task_runs").select("id").eq("task_id", task)).data).toHaveLength(1);
    expect((await alice.client.from("agent_records").select("id").eq("id", record)).data).toHaveLength(1);
    for (const other of [teammate, bob]) {
      for (const [table, column, value] of [
        ["agent_tasks", "id", task],
        ["agent_task_runs", "task_id", task],
        ["agent_records", "id", record],
        ["agent_tasks", "workspace_id", ws],
        ["agent_records", "workspace_id", ws],
      ] as const) {
        const { data, error } = await other.client.from(table).select("id").eq(column, value);
        expect(error, table).toBeNull();
        expect(data, table).toEqual([]);
      }
    }
  });

  it("can't be changed or deleted by anyone else", async () => {
    for (const other of [teammate, bob]) {
      expect((await other.client.from("agent_tasks").update({ instructions: "forged" }).eq("id", task).select("id")).data ?? []).toEqual([]);
      expect((await other.client.from("agent_task_runs").update({ status: "skipped" }).eq("id", run).select("id")).data ?? []).toEqual([]);
      expect((await other.client.from("agent_records").update({ title: "forged" }).eq("id", record).select("id")).data ?? []).toEqual([]);
      expect((await other.client.from("agent_tasks").delete().eq("id", task).select("id")).data ?? []).toEqual([]);
      expect((await other.client.from("agent_task_runs").delete().eq("id", run).select("id")).data ?? []).toEqual([]);
      expect((await other.client.from("agent_records").delete().eq("id", record).select("id")).data ?? []).toEqual([]);
    }
    expect((await alice.client.from("agent_tasks").select("instructions").eq("id", task).single()).data?.instructions).toBe(
      "alice-secret-goal",
    );
    expect((await alice.client.from("agent_task_runs").select("status").eq("id", run).single()).data?.status).toBe("queued");
    expect((await alice.client.from("agent_records").select("title").eq("id", record).single()).data?.title).toBe("alice-secret-job");
  });

  it("refuse rows that claim another member or workspace", async () => {
    // A teammate writing as Alice, and Bob writing into Alice's workspace.
    expect((await teammate.client.from("agent_tasks").insert({ workspace_id: ws, user_id: alice.userId, title: "x" })).error).not.toBeNull();
    expect((await bob.client.from("agent_tasks").insert({ workspace_id: ws, title: "x" })).error).not.toBeNull();
    expect(
      (await bob.client.from("agent_records").insert({ workspace_id: ws, collection: "jobs", key: "k" })).error,
    ).not.toBeNull();
    expect(
      (await teammate.client.from("agent_records").insert({ workspace_id: ws, user_id: alice.userId, collection: "jobs", key: "k" })).error,
    ).not.toBeNull();
    expect(
      (await bob.client.from("agent_task_runs").insert({ task_id: task, workspace_id: ws, scheduled_for: "2026-10-21T12:00:00Z" })).error,
    ).not.toBeNull();
  });

  it("can't point at someone else's conversation, skill, task, or message", async () => {
    // A teammate's own task naming Alice's conversation, in the same workspace.
    expect(
      (await teammate.client.from("agent_tasks").insert({ workspace_id: ws, title: "x", conversation_id: conversation })).error,
    ).not.toBeNull();
    // Bob's task naming a skill from Alice's workspace.
    expect((await bob.client.from("agent_tasks").insert({ workspace_id: bobWs, title: "x", skill_id: skill })).error).not.toBeNull();
    // Bob's run on Alice's task, filed under his own workspace.
    expect(
      (await bob.client.from("agent_task_runs").insert({ task_id: task, workspace_id: bobWs, scheduled_for: "2026-10-21T12:00:00Z" }))
        .error,
    ).not.toBeNull();
    // A teammate's record attached to Alice's task or message.
    expect(
      (await teammate.client.from("agent_records").insert({ workspace_id: ws, collection: "jobs", key: "k1", task_id: task })).error,
    ).not.toBeNull();
    expect(
      (await teammate.client.from("agent_records").insert({ workspace_id: ws, collection: "jobs", key: "k2", source_message_id: message }))
        .error,
    ).not.toBeNull();

    // And the same through updates on rows they do own. A teammate may use a workspace skill.
    const own = await teammate.client.from("agent_tasks").insert({ workspace_id: ws, title: "Mine", skill_id: skill }).select("id").single();
    expect(own.error).toBeNull();
    expect((await teammate.client.from("agent_tasks").update({ conversation_id: conversation }).eq("id", own.data!.id)).error).not.toBeNull();
    const bobs = await bob.client.from("agent_tasks").insert({ workspace_id: bobWs, title: "Mine" }).select("id").single();
    expect(bobs.error).toBeNull();
    expect((await bob.client.from("agent_tasks").update({ skill_id: skill }).eq("id", bobs.data!.id)).error).not.toBeNull();
  });

  it("can't be moved to another workspace or owner", async () => {
    expect((await alice.client.from("agent_tasks").update({ workspace_id: bobWs }).eq("id", task)).error).not.toBeNull();
    expect((await alice.client.from("agent_tasks").update({ user_id: bob.userId }).eq("id", task)).error).not.toBeNull();
    expect((await alice.client.from("agent_tasks").update({ template_task_id: "other" }).eq("id", task)).error).not.toBeNull();
    expect((await alice.client.from("agent_task_runs").update({ task_id: crypto.randomUUID() }).eq("id", run)).error).not.toBeNull();
    expect((await alice.client.from("agent_records").update({ workspace_id: bobWs }).eq("id", record)).error).not.toBeNull();
    expect((await alice.client.from("agent_records").update({ collection: "other" }).eq("id", record)).error).not.toBeNull();
    expect((await alice.client.from("messages").update({ origin: { kind: "forged" } }).eq("id", message)).error).not.toBeNull();
  });

  it("keep plans to at most 30 well-formed steps", async () => {
    const tooMany = Array.from({ length: 31 }, (_, i) => step(String(i)));
    expect((await alice.client.from("agent_tasks").update({ plan: tooMany }).eq("id", task)).error).not.toBeNull();
    expect((await alice.client.from("agent_tasks").update({ plan: [{ id: "a", text: "x", status: "maybe" }] }).eq("id", task)).error).not.toBeNull();
    expect((await alice.client.from("agent_tasks").update({ plan: { steps: [] } }).eq("id", task)).error).not.toBeNull();
    const thirty = Array.from({ length: 30 }, (_, i) => step(String(i), "needs_you"));
    expect((await alice.client.from("agent_tasks").update({ plan: thirty }).eq("id", task)).error).toBeNull();
  });

  it("run at most once per scheduled time", async () => {
    const again = await alice.client.from("agent_task_runs").insert({ task_id: task, workspace_id: ws, scheduled_for: "2026-10-20T12:00:00Z" });
    expect(again.error?.code).toBe("23505");
  });

  it("hold at most 500 records per collection", async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ workspace_id: ws, collection: "capped", key: `k${i}` }));
    expect((await alice.client.from("agent_records").insert(rows)).error).toBeNull();
    const over = await alice.client.from("agent_records").insert({ workspace_id: ws, collection: "capped", key: "k500" });
    expect(over.error?.hint).toBe("record_limit");
    // Updating one that exists, other collections, and other members are unaffected.
    expect((await alice.client.from("agent_records").update({ status: "seen" }).eq("collection", "capped").eq("key", "k0")).error).toBeNull();
    expect((await alice.client.from("agent_records").insert({ workspace_id: ws, collection: "other", key: "k" })).error).toBeNull();
    expect((await teammate.client.from("agent_records").insert({ workspace_id: ws, collection: "capped", key: "k" })).error).toBeNull();
  });

  it("upsert records by key and start each scheduled run once, through the library", async () => {
    const tenant = {
      db: alice.client,
      userId: alice.userId,
      email: alice.email,
      workspace: { id: ws },
    } as unknown as Tenant;
    const first = await upsertRecord(tenant, { collection: "leads", key: "acme", title: "Acme", fields: { size: 10 } });
    const second = await upsertRecord(tenant, { collection: "leads", key: "acme", status: "contacted" });
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ title: "Acme", status: "contacted", fields: { size: 10 } });
    await expect(upsertRecord(tenant, { collection: "capped", key: "new" })).rejects.toMatchObject({ status: 409 });
    await expect(upsertRecord(tenant, { collection: "leads", key: "x", taskId: crypto.randomUUID() })).rejects.toMatchObject({ status: 400 });

    const at = "2026-11-01T12:00:00Z";
    expect(await appendRun(tenant, task, { scheduledFor: at })).toMatchObject({ taskId: task, status: "queued" });
    expect(await appendRun(tenant, task, { scheduledFor: at })).toBeNull();
  });

  it("let go of deleted conversations and skills, and take runs with the task", async () => {
    expect((await alice.client.from("workspace_skills").delete().eq("id", skill)).error).toBeNull();
    expect((await alice.client.from("conversations").delete().eq("id", conversation)).error).toBeNull();
    const kept = await alice.client.from("agent_tasks").select("skill_id, conversation_id, workspace_id").eq("id", task).single();
    expect(kept.data).toEqual({ skill_id: null, conversation_id: null, workspace_id: ws });
    expect((await alice.client.from("agent_records").select("source_message_id").eq("id", record).single()).data?.source_message_id).toBeNull();

    expect((await alice.client.from("agent_tasks").delete().eq("id", task).select("id")).data).toHaveLength(1);
    expect((await alice.client.from("agent_task_runs").select("id").eq("id", run)).data).toEqual([]);
    expect((await alice.client.from("agent_records").select("task_id").eq("id", record).single()).data?.task_id).toBeNull();
  });
});

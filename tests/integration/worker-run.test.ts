import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { requestStop } from "@/lib/tasks";
import { runClaimedTask } from "@/lib/tasks/run-task";
import { resolveTenant, sessionFor, type Tenant } from "@/lib/tenant-core";
import { createAccount, createWorkspace, serviceClient, SUPABASE_URL, type TestAccount } from "./helpers";

// What the worker does with a claimed run once it's signed in as the task's member: the same
// turn engine as chat (the mock agent here), under the member's RLS. Opening the session
// itself (trigger/lib/elevated.ts) needs the secret key and is exercised separately.

let alice: TestAccount;
let tenant: Tenant;
let admin: SupabaseClient;

beforeAll(async () => {
  alice = await createAccount("worker-run");
  const ws = await createWorkspace(alice, "Worker Run");
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= SUPABASE_URL;
  process.env.AGENT_PROVIDER = "mock";
  process.env.PREVIEW_FEATURE_EMAILS = alice.email;
  tenant = (await resolveTenant(sessionFor(alice.client, { id: alice.userId, email: alice.email }), ws))!;
  admin = await serviceClient();
});

/** A due task, claimed the way the dispatcher claims it. */
async function claimedTask(fields: Record<string, unknown> = {}) {
  const { data, error } = await alice.client
    .from("agent_tasks")
    .insert({
      workspace_id: tenant.workspace.id,
      title: "Weekly roundup",
      instructions: "Summarize what's new.",
      schedule: { every: "day", at: "08:00" },
      next_run_at: new Date(Date.now() - 60_000).toISOString(),
      ...fields,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  const claimed = ((await admin.rpc("worker_claim_due_tasks", { p_limit: 500 })).data as { run_id: string; task_id: string }[]).find(
    (r) => r.task_id === data!.id,
  );
  return { taskId: data!.id as string, runId: claimed?.run_id as string };
}

const runRow = async (runId: string) =>
  (await alice.client.from("agent_task_runs").select("status, reason, message_id, cancel_requested_at").eq("id", runId).single()).data!;

describe("running a claimed task", () => {
  it("runs it in the task's conversation and records the outcome, once", async () => {
    const claimed = await claimedTask();
    expect(await runClaimedTask(tenant, claimed)).toEqual({ status: "done", reason: null });

    const run = await runRow(claimed.runId);
    expect(run.status).toBe("done");
    const { data: task } = await alice.client.from("agent_tasks").select("conversation_id, last_run_at").eq("id", claimed.taskId).single();
    expect(task!.conversation_id).toBeTruthy();
    expect(task!.last_run_at).toBeTruthy();
    const { data: messages } = await alice.client
      .from("messages")
      .select("id, role, status, content, origin")
      .eq("conversation_id", task!.conversation_id)
      .order("created_at");
    expect(messages!.map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
    expect(messages![0]).toMatchObject({ content: "Summarize what's new.", origin: { kind: "task", taskId: claimed.taskId, runId: claimed.runId } });
    expect(run.message_id).toBe(messages![1].id);
    const { data: usage } = await alice.client.from("usage_events").select("kind").eq("message_id", messages![1].id);
    expect(usage).toEqual([{ kind: "task_run" }]);

    // A repeated delivery of the same run does nothing.
    expect(await runClaimedTask(tenant, claimed)).toEqual({ status: "done", reason: null });
    const { count } = await alice.client.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", task!.conversation_id);
    expect(count).toBe(2);
  });

  it("skips a task that was paused after it was claimed", async () => {
    const claimed = await claimedTask();
    await alice.client.from("agent_tasks").update({ status: "paused" }).eq("id", claimed.taskId);
    expect(await runClaimedTask(tenant, claimed)).toEqual({ status: "skipped", reason: "paused" });
    expect((await runRow(claimed.runId)).status).toBe("skipped");
  });

  it("skips while the task's conversation is still busy", async () => {
    const conversation = crypto.randomUUID();
    await alice.client.from("conversations").insert({ id: conversation, workspace_id: tenant.workspace.id, title: "Busy" });
    await alice.client
      .from("messages")
      .insert({ conversation_id: conversation, workspace_id: tenant.workspace.id, role: "assistant", content: "", status: "streaming" });
    const claimed = await claimedTask({ conversation_id: conversation });
    expect(await runClaimedTask(tenant, claimed)).toEqual({ status: "skipped", reason: "busy" });
  });

  it("skips a run the member asked to stop", async () => {
    const claimed = await claimedTask();
    await alice.client.from("agent_task_runs").update({ cancel_requested_at: new Date().toISOString() }).eq("id", claimed.runId);
    expect(await runClaimedTask(tenant, claimed)).toEqual({ status: "skipped", reason: "stopped" });
  });

  it("flags the live run when the member stops a task's conversation", async () => {
    const conversation = crypto.randomUUID();
    await alice.client.from("conversations").insert({ id: conversation, workspace_id: tenant.workspace.id, title: "Live" });
    const claimed = await claimedTask({ conversation_id: conversation });
    await alice.client.from("agent_task_runs").update({ status: "running" }).eq("id", claimed.runId);
    await requestStop(tenant, conversation);
    expect((await runRow(claimed.runId)).cancel_requested_at).toBeTruthy();
  });
});

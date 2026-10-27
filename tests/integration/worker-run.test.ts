import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { buildTurnDeps } from "@/lib/chat/run";
import { startTurn } from "@/lib/chat/turn";
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

  it("asks for a change the first time, and approves it on later runs once the member said not to ask again", async () => {
    const first = await claimedTask({ instructions: "Label my inbox." });
    expect(await runClaimedTask(tenant, first)).toEqual({ status: "running", reason: "waiting_on_you" });
    const { data: task } = await alice.client.from("agent_tasks").select("conversation_id").eq("id", first.taskId).single();
    const conversationId = task!.conversation_id as string;
    const asked = async () =>
      (await alice.client.from("approvals").select("id, status, standing, decided_via").eq("conversation_id", conversationId).order("created_at")).data!;
    const [request] = await asked();
    expect(request).toMatchObject({ status: "pending", standing: "gmail_labels" });

    // The member taps Approve with "Don't ask again on this task".
    let finished!: () => void;
    const done = new Promise<void>((resolve) => (finished = resolve));
    const { deps, request: turn } = await buildTurnDeps(tenant, {
      conversationId,
      input: { kind: "decide", approvalId: request.id, decision: "approve", standing: "grant" },
      onFinished: () => finished(),
    });
    await new Response(await startTurn(deps, turn)).text();
    await done;
    const { data: granted } = await alice.client.from("agent_tasks").select("allowed_actions").eq("id", first.taskId).single();
    expect(granted!.allowed_actions).toEqual(["gmail_labels"]);
    expect((await asked())[0]).toMatchObject({ status: "approved", decided_via: "tap" });
    // The run it waited on is over once the reply it continued is.
    expect(await runRow(first.runId)).toMatchObject({ status: "done", reason: null });

    // The next run asks for the same kind of change and approves it under that OK, without waiting.
    await alice.client.from("agent_tasks").update({ next_run_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", first.taskId);
    const next = ((await admin.rpc("worker_claim_due_tasks", { p_limit: 500 })).data as { run_id: string; task_id: string }[]).find(
      (r) => r.task_id === first.taskId,
    )!;
    expect(await runClaimedTask(tenant, { taskId: first.taskId, runId: next.run_id })).toEqual({ status: "done", reason: null });
    expect((await asked())[1]).toMatchObject({ status: "approved", standing: "gmail_labels", decided_via: "standing" });

    // Taken back, the run after asks again.
    await alice.client.from("agent_tasks").update({ allowed_actions: [], next_run_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", first.taskId);
    const third = ((await admin.rpc("worker_claim_due_tasks", { p_limit: 500 })).data as { run_id: string; task_id: string }[]).find(
      (r) => r.task_id === first.taskId,
    )!;
    expect(await runClaimedTask(tenant, { taskId: first.taskId, runId: third.run_id })).toEqual({ status: "running", reason: "waiting_on_you" });
    expect((await asked())[2]).toMatchObject({ status: "pending" });
  });

  it("won't let a member mark a request as decided by a standing OK it doesn't qualify for", async () => {
    const conversation = crypto.randomUUID();
    await alice.client.from("conversations").insert({ id: conversation, workspace_id: tenant.workspace.id, title: "Forged" });
    const { data: message } = await alice.client
      .from("messages")
      .insert({ conversation_id: conversation, workspace_id: tenant.workspace.id, role: "assistant", content: "", status: "awaiting" })
      .select("id")
      .single();
    const { data: approval } = await alice.client
      .from("approvals")
      .insert({ workspace_id: tenant.workspace.id, conversation_id: conversation, message_id: message!.id, summary: "Send it", provider: "mock" })
      .select("id")
      .single();
    const { error } = await alice.client.from("approvals").update({ status: "approved", decided_via: "standing" }).eq("id", approval!.id);
    expect(error).not.toBeNull();
    const { error: kind } = await alice.client.from("agent_tasks").insert({ workspace_id: tenant.workspace.id, title: "x", instructions: "", allowed_actions: ["send_email"] });
    expect(kind).not.toBeNull();
  });
});

import { agentEnabledFor } from "@/lib/agent";
import { buildTurnDeps } from "@/lib/chat/run";
import { storeFor } from "@/lib/chat/store-for";
import { TurnError, startTurn } from "@/lib/chat/turn";
import { previewEnabled } from "@/lib/flags";
import type { Tenant } from "@/lib/tenant-core";
import { appendRun, beginRun, getRun, getTask, markTaskRan, runStopRequested, settleRun, updateTask } from "./index";
import type { AgentTask, RunStatus } from "./types";

// Runs one of a member's tasks as that member: its brief goes to the agent in the task's own
// conversation (made on the first run), and no one watches the stream, so the member hears
// how it went from a notification and follows it in that conversation. "Run now" and the
// background worker both start runs here. Free of Next.js so the worker can use it.

export interface StartedTaskRun {
  conversationId: string;
  runId: string | null;
  /** Settles once the run's outcome is recorded. The caller keeps the process alive until then. */
  settled: Promise<RunOutcome>;
}

export interface RunOutcome {
  status: RunStatus;
  reason: string | null;
}

/**
 * Starts a run of `task`. With `runId` (a run the scheduler recorded and `beginRun` moved to
 * running) that run is used; otherwise one is recorded for now. Throws a TurnError when the run can't start (the
 * run is recorded as skipped or failed first).
 */
export async function startTaskRun(tenant: Tenant, task: AgentTask, options: { runId?: string } = {}): Promise<StartedTaskRun> {
  let runId: string | null = options.runId ?? null;
  try {
    let conversationId = task.conversationId;
    if (!conversationId) {
      conversationId = crypto.randomUUID();
      await storeFor(tenant).createConversation({ id: conversationId, title: task.title });
      await updateTask(tenant, task.id, { conversationId });
    }
    runId ??= (await appendRun(tenant, task.id, { scheduledFor: new Date(), status: "running" }))?.id ?? null;

    let settle!: (outcome: RunOutcome) => void;
    const settled = new Promise<RunOutcome>((resolve) => (settle = resolve));
    const id = runId;
    const { deps, request } = await buildTurnDeps(tenant, {
      conversationId,
      input: { kind: "task", taskId: task.id, runId: id },
      // A stop can come from any server (the member's browser talks to the app, not the worker).
      shouldStop: id ? () => runStopRequested(tenant, id) : undefined,
      onFinished: async (message, _conversation, { report }) => {
        // A run waiting on the member's approval isn't over: approving continues it.
        const outcome: RunOutcome =
          message.status === "complete"
            ? { status: "done", reason: report?.outcome ?? null }
            : message.status === "awaiting"
              ? { status: "running", reason: "waiting_on_you" }
              : { status: "failed", reason: message.status };
        try {
          if (id) await settleRun(tenant, id, { ...outcome, messageId: message.id });
          await markTaskRan(tenant, task.id);
        } catch (e) {
          console.error("[tasks] couldn't record the run's outcome", e);
        } finally {
          settle(outcome);
        }
      },
    });
    const stream = await startTurn(deps, request);
    // No one reads this stream: the member follows the run in its conversation.
    void stream.cancel();
    return { conversationId, runId, settled };
  } catch (error) {
    if (runId) {
      const reason = error instanceof TurnError ? error.message : "The run couldn't start.";
      const status = error instanceof TurnError && error.status === 429 ? "skipped" : "failed";
      await settleRun(tenant, runId, { status, reason }).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Runs a run the scheduler claimed, as the task's member, and resolves with how it ended.
 * Skips it (recording why) when the task is no longer active, its conversation is waiting
 * on the member or still busy, or the run was already started or stopped.
 */
export async function runClaimedTask(tenant: Tenant, claimed: { taskId: string; runId: string }): Promise<RunOutcome> {
  const skip = async (reason: string): Promise<RunOutcome> => {
    await settleRun(tenant, claimed.runId, { status: "skipped", reason });
    return { status: "skipped", reason };
  };

  const run = await getRun(tenant, claimed.runId);
  // Gone with its task, or already picked up by an earlier attempt.
  if (!run || run.taskId !== claimed.taskId) return { status: "skipped", reason: "gone" };
  if (run.status !== "queued") return { status: run.status, reason: run.reason };
  if (run.cancelRequestedAt) return skip("stopped");

  const task = await getTask(tenant, claimed.taskId);
  if (!task) return { status: "skipped", reason: "gone" };
  if (task.status !== "active") return skip(task.status);
  if (!previewEnabled(tenant, "tasks") || !agentEnabledFor(tenant.workspace.id)) return skip("agent_unavailable");

  if (task.conversationId) {
    const store = storeFor(tenant);
    if (await store.pendingApproval(task.conversationId)) return skip("waiting_on_you");
    if ((await store.listMessages(task.conversationId)).at(-1)?.status === "streaming") return skip("busy");
  }

  // Only one attempt gets to start it.
  if (!(await beginRun(tenant, run.id))) return { status: "skipped", reason: "already_started" };
  try {
    const started = await startTaskRun(tenant, task, { runId: run.id });
    return await started.settled;
  } catch (error) {
    // startTaskRun recorded it; a refused claim (429) is a skip, anything else a failure.
    if (error instanceof TurnError) {
      return { status: error.status === 429 ? "skipped" : "failed", reason: error.message };
    }
    throw error;
  }
}

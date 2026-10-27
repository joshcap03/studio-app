import { agentEnabledFor } from "@/lib/agent";
import { MAX_STANDING, REQUEST_LIMIT_MS, SAVE_MARGIN_MS, buildTurnDeps, standingCarryOn, type RunOptions } from "@/lib/chat/run";
import { storeFor } from "@/lib/chat/store-for";
import { TurnError, startTurn } from "@/lib/chat/turn";
import type { Tenant } from "@/lib/tenant-core";
import { KEEP_GOING, appendRun, beginRun, claimKeptRun, deferRun, getRun, getTask, markTaskRan, runOutcome, runStopRequested, settleRun, updateTask } from "./index";
import { getWatch } from "./watches";
import type { ChatMessage } from "@/lib/types";
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
  /** For a watch's run that isn't starting yet: when to ask again (epoch ms). */
  retryAt?: number;
}

// A watch's run carries events that would be lost if it were skipped, so while its conversation
// is busy or waiting on the member it waits, folding in events that arrive meanwhile, and is
// skipped (its events kept on it, for the member to see) only after this long.
const WAIT = {
  busy: { every: 5 * 60_000, giveUpAfter: 30 * 60_000 },
  waiting_on_you: { every: 10 * 60_000, giveUpAfter: 2 * 3_600_000 },
} as const;

/**
 * Starts a run of `task`. With `runId` (a run the scheduler recorded and `beginRun` moved to
 * running) that run is used; otherwise one is recorded for now. Throws a TurnError when the run can't start (the
 * run is recorded as skipped or failed first). `continues`: carry on that run's job, which its
 * latest reply ran out of time for (keep_going), in a reply of its own; a refusal leaves the run
 * as it is.
 */
export async function startTaskRun(tenant: Tenant, task: AgentTask, options: { runId?: string; continues?: boolean } = {}): Promise<StartedTaskRun> {
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
    const convo = conversationId;
    // A stop can come from any server (the member's browser talks to the app, not the worker).
    const shouldStop = id ? () => runStopRequested(tenant, id) : undefined;
    const onFinished: RunOptions["onFinished"] = async (message, _conversation, { report }) => {
      // A run waiting on the member's approval isn't over: approving continues it.
      const outcome: RunOutcome = runOutcome(message, report);
      try {
        if (id) await settleRun(tenant, id, { ...outcome, messageId: message.id });
        await markTaskRan(tenant, task.id);
      } catch (e) {
        console.error("[tasks] couldn't record the run's outcome", e);
      } finally {
        settle(outcome);
      }
    };
    // A request of a kind the member OK'd for good (for all their agents, or on this task) is
    // approved here, as the task's run, and the run carries on without waking them; anything else
    // waits for them. Read fresh each time, so an OK taken back mid-run stops the next one. At
    // most MAX_STANDING a run.
    let standingLeft = MAX_STANDING;
    // Carried-on runs share the request this run started in, and its time.
    const deadline = Date.now() + REQUEST_LIMIT_MS - SAVE_MARGIN_MS;
    const carryOn = async (message: ChatMessage): Promise<boolean> => {
      if (message.status !== "awaiting" || standingLeft <= 0) return false;
      const current = await getTask(tenant, task.id);
      const carried = await standingCarryOn(tenant, convo, message, { onFinished, shouldStop, carryOn, standingLeft, deadline, task: current });
      if (carried) standingLeft--;
      return carried;
    };
    const { deps, request } = await buildTurnDeps(tenant, {
      conversationId,
      input: options.continues ? { kind: "continue" } : { kind: "task", taskId: task.id, runId: id },
      deadline,
      shouldStop,
      onFinished,
      carryOn,
    });
    const stream = await startTurn(deps, request);
    // No one reads this stream: the member follows the run in its conversation.
    void stream.cancel();
    return { conversationId, runId, settled };
  } catch (error) {
    if (runId && !options.continues) {
      const reason = error instanceof TurnError ? error.message : "The run couldn't start.";
      const status = error instanceof TurnError && error.status === 429 ? "skipped" : "failed";
      await settleRun(tenant, runId, { status, reason }).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Carries on a run whose latest reply ran out of time with more to do (keep_going), for the
 * worker, in a request of its own, and resolves with how it ended (still going again, done,
 * waiting on the member, or failed). Nothing happens when the run isn't waiting to carry on, the
 * task was paused, or the member's page carried it on first.
 */
export async function continueClaimedTask(tenant: Tenant, claimed: { taskId: string; runId: string }): Promise<RunOutcome> {
  const run = await getRun(tenant, claimed.runId);
  if (!run || run.taskId !== claimed.taskId) return { status: "skipped", reason: "gone" };
  if (run.status !== "running" || run.reason !== KEEP_GOING) return { status: run.status, reason: run.reason };
  const task = await getTask(tenant, claimed.taskId);
  const done = async (reason: string): Promise<RunOutcome> => {
    await settleRun(tenant, run.id, { status: "done", reason });
    return { status: "done", reason };
  };
  if (!task) return { status: "skipped", reason: "gone" };
  if (run.cancelRequestedAt) return done("stopped");
  if (task.status !== "active") return done(task.status);
  if (!agentEnabledFor(tenant.workspace.id)) return done("agent_unavailable");
  if (!(await claimKeptRun(tenant, run.id))) return { status: "running", reason: "continued_elsewhere" };
  try {
    return await (await startTaskRun(tenant, task, { runId: run.id, continues: true })).settled;
  } catch (error) {
    // The member's page carried it on first (or wrote meanwhile): that reply settles the run.
    if (error instanceof TurnError) return { status: "running", reason: "continued_elsewhere" };
    throw error;
  }
}

/**
 * Runs a run the scheduler (or a watch) claimed, as the task's member, and resolves with how it
 * ended. Skips it (recording why) when the task is no longer active, its conversation is waiting
 * on the member or still busy, or the run was already started or stopped. A watch's run waits
 * instead of being skipped, for a while (WAIT), answering when to ask again.
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
  const watched = run.events !== null;
  // Still gathering events (or put back to wait): not yet.
  if (watched && run.notBefore && run.notBefore > Date.now() + 1000) return { status: "queued", reason: "not_yet", retryAt: run.notBefore };
  const hold = async (reason: keyof typeof WAIT): Promise<RunOutcome> => {
    if (!watched || Date.now() - run.scheduledFor > WAIT[reason].giveUpAfter) return skip(reason);
    const at = new Date(Date.now() + WAIT[reason].every);
    if (!(await deferRun(tenant, run.id, at))) return { status: "skipped", reason: "already_started" };
    return { status: "queued", reason, retryAt: at.getTime() };
  };

  const task = await getTask(tenant, claimed.taskId);
  if (!task) return { status: "skipped", reason: "gone" };
  if (task.status !== "active") return skip(task.status);
  if (watched) {
    const watch = await getWatch(tenant, task.id);
    if (watch?.status !== "watching") return skip(watch ? watch.status : "not_watching");
  }
  if (!agentEnabledFor(tenant.workspace.id)) return skip("agent_unavailable");

  if (task.conversationId) {
    const store = storeFor(tenant);
    if (await store.pendingApproval(task.conversationId)) return hold("waiting_on_you");
    if ((await store.listMessages(task.conversationId)).at(-1)?.status === "streaming") return hold("busy");
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

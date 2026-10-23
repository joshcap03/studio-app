import { logger, task } from "@trigger.dev/sdk";
import { startRunInApp } from "@/lib/tasks/start-in-app";
import { asMember, MemberUnavailable, settleUnstartedRun, SignInRateLimited } from "./lib/elevated";

// Starts one claimed run of a member's task. The worker only signs in as the task's member;
// the app runs the task (POST /api/tasks/<id>/runs/<run>), as them under RLS and with its own
// settings and keys, exactly like "Run now". So the worker needs no agent or app keys. A run
// that pauses for the member's approval ends here; they approve in the app, which continues it.
// A run that can't be started is settled as such, so the member sees it on the task instead of
// a run queued forever.

export interface RunTaskPayload {
  runId: string;
  taskId: string;
  workspaceId: string;
  userId: string;
  /** Times this run was put back because sign-in was rate limited. */
  deferred?: number;
}

const MAX_DEFERRALS = 5;
// The app's runs stop at its function limit (300s); give the answer a little longer to arrive.
const APP_TIMEOUT_MS = 320_000;

function appUrl(): string {
  const value = process.env.APP_URL?.trim();
  if (!value) throw new Error("APP_URL is not set");
  return value;
}

/** Records why a run never started; a failure to record it is logged, never hides the cause. */
async function settle(payload: RunTaskPayload, status: "skipped" | "failed", reason: string): Promise<void> {
  try {
    await settleUnstartedRun(payload.runId, status, reason);
  } catch (e) {
    logger.error("couldn't settle the run", { runId: payload.runId, error: String(e) });
  }
}

export const runTask = task({
  id: "run-task",
  // Never retried blindly: the agent may have done work. A run that can't start is recorded as such.
  retry: { maxAttempts: 1 },
  queue: { concurrencyLimit: 10 },
  maxDuration: 600,
  run: async (payload: RunTaskPayload) => {
    try {
      // The session stays open until the app answers, so the run's queries keep a live sign-in.
      const outcome = await asMember(payload.userId, (accessToken) =>
        startRunInApp(appUrl(), payload, accessToken, { timeoutMs: APP_TIMEOUT_MS }),
      );
      logger.info("run settled", { runId: payload.runId, ...outcome });
      return outcome;
    } catch (error) {
      if (error instanceof SignInRateLimited && (payload.deferred ?? 0) < MAX_DEFERRALS) {
        // The run is still queued; try again shortly with a fresh sign-in.
        const deferred = (payload.deferred ?? 0) + 1;
        logger.warn("sign-in rate limited; deferring", { runId: payload.runId, deferred });
        await runTask.trigger({ ...payload, deferred }, { delay: `${deferred * 2}m`, idempotencyKey: `${payload.runId}:deferred:${deferred}`, idempotencyKeyTTL: "1d" });
        return { status: "queued", reason: "deferred" };
      }
      if (error instanceof MemberUnavailable) {
        logger.warn(error.message, { runId: payload.runId });
        await settle(payload, "skipped", "member_unavailable");
        return { status: "skipped", reason: "member_unavailable" };
      }
      // The cause stays in the worker's logs; the member sees that it didn't start. A run the app
      // already began isn't touched (only a queued one is settled), so it ends as the app records.
      logger.error("couldn't start the run", { runId: payload.runId, error: String(error) });
      await settle(payload, "failed", "not_started");
      throw error;
    }
  },
});

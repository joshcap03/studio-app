import { logger, task } from "@trigger.dev/sdk";
import { asMember, MemberUnavailable, SignInRateLimited } from "./lib/elevated";

// Starts one claimed run of a member's task. The worker only signs in as the task's member;
// the app runs the task (POST /api/tasks/<id>/runs/<run>), as them under RLS and with its own
// settings and keys, exactly like "Run now". So the worker needs no agent or app keys. A run
// that pauses for the member's approval ends here; they approve in the app, which continues it.
// A watch's run the app isn't starting yet comes back with when to ask again, and is put back.

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
  const value = process.env.APP_URL?.trim().replace(/\/+$/, "");
  if (!value) throw new Error("APP_URL is not set");
  return value;
}

/** Asks the app to run the claimed run as the member; resolves with how it ended. */
async function startInApp(payload: RunTaskPayload, accessToken: string): Promise<{ status: string; reason: string | null; retryAt?: number }> {
  const url = `${appUrl()}/api/tasks/${payload.taskId}/runs/${payload.runId}?workspace=${payload.workspaceId}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(APP_TIMEOUT_MS),
  });
  if (res.status === 404) return { status: "skipped", reason: "not_found" };
  if (!res.ok) throw new Error(`The app couldn't start run ${payload.runId}: ${res.status}`);
  return (await res.json()) as { status: string; reason: string | null; retryAt?: number };
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
      const outcome = await asMember(payload.userId, (accessToken) => startInApp(payload, accessToken));
      // A watch's run that's waiting (for more events, or for its conversation) says when to ask again.
      if (outcome.status === "queued" && typeof outcome.retryAt === "number" && Number.isFinite(outcome.retryAt)) {
        const at = new Date(Math.max(outcome.retryAt, Date.now() + 5_000));
        await runTask.trigger({ ...payload, deferred: 0 }, { delay: at, idempotencyKey: `${payload.runId}:at:${at.getTime()}`, idempotencyKeyTTL: "1d" });
        logger.info("run waits", { runId: payload.runId, reason: outcome.reason, until: at.toISOString() });
        return outcome;
      }
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
        return { status: "skipped", reason: "member_unavailable" };
      }
      throw error;
    }
  },
});

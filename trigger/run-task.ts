import { logger, task } from "@trigger.dev/sdk";
import { runClaimedTask } from "@/lib/tasks/run-task";
import { resolveTenant } from "@/lib/tenant-core";
import { asMember, MemberUnavailable, SignInRateLimited } from "./lib/elevated";

// Runs one claimed run of a member's task, as that member: everything here goes through their
// own session under RLS, the same code as "Run now". A run that pauses for the member's
// approval ends here; they approve in the app, which continues it.

export interface RunTaskPayload {
  runId: string;
  taskId: string;
  workspaceId: string;
  userId: string;
  /** Times this run was put back because sign-in was rate limited. */
  deferred?: number;
}

const MAX_DEFERRALS = 5;

export const runTask = task({
  id: "run-task",
  // Never retried blindly: the agent may have done work. A run that can't start is recorded as such.
  retry: { maxAttempts: 1 },
  queue: { concurrencyLimit: 10 },
  run: async (payload: RunTaskPayload) => {
    try {
      return await asMember(payload.userId, async (session) => {
        // Membership is checked again under RLS: a member who left the workspace gets no run.
        const tenant = await resolveTenant(session, payload.workspaceId);
        if (!tenant || tenant.workspace.id !== payload.workspaceId) {
          logger.warn("member no longer in the task's workspace", { runId: payload.runId });
          return { status: "skipped", reason: "not_a_member" };
        }
        const outcome = await runClaimedTask(tenant, { taskId: payload.taskId, runId: payload.runId });
        logger.info("run settled", { runId: payload.runId, ...outcome });
        return outcome;
      });
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

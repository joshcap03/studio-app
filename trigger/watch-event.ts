import { logger, task } from "@trigger.dev/sdk";
import { claimWatchEvent } from "./lib/elevated";
import { runTask } from "./run-task";

// One event from a member's watch (docs/watches.md), as the app's webhook route verified it and
// handed it over: matched to its watch and its owner in the database, folded into the task's
// waiting run or starting a new one, which runs like any task run once its wait is over. A repeat
// of the same event, or one for a watch that's off or not its sender's, does nothing.

export interface WatchEventPayload {
  /** Composio's webhook-id for this delivery. */
  eventId: string;
  triggerId: string;
  /** Whose trigger Composio signed it as. */
  composioUserId: string;
  /** What the run carries: { id, at, summary, data }. */
  event: { id: string; at: string; summary: string; data: Record<string, unknown> };
}

export const watchEvent = task({
  id: "watch-event",
  // Claiming is idempotent per event, so a failed attempt is safe to repeat.
  retry: { maxAttempts: 3 },
  queue: { concurrencyLimit: 20 },
  maxDuration: 60,
  run: async (payload: WatchEventPayload) => {
    const claimed = await claimWatchEvent(payload);
    if (!claimed) {
      logger.info("event not taken", { eventId: payload.eventId });
      return { taken: false };
    }
    if (claimed.start) {
      await runTask.trigger(
        { runId: claimed.runId, taskId: claimed.taskId, workspaceId: claimed.workspaceId, userId: claimed.userId },
        { delay: new Date(claimed.notBefore), idempotencyKey: `${claimed.runId}:watch`, idempotencyKeyTTL: "1d" },
      );
    }
    logger.info("event taken", { eventId: payload.eventId, runId: claimed.runId, started: claimed.start });
    return { taken: true, runId: claimed.runId, started: claimed.start };
  },
});

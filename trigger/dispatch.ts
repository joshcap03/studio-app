import { idempotencyKeys, logger, schedules } from "@trigger.dev/sdk";
import { nextRunAfter, taskScheduleSchema } from "@/lib/tasks/schedule";
import { claimDueTasks, setNextRun } from "./lib/elevated";
import { runTask } from "./run-task";

// Every two minutes: claims the tasks that are due (one run each), moves each task's next run
// on, and starts the runs. A dispatch that dies partway is safe to repeat: claiming returns
// the same run for the same time, and a run's id is its idempotency key.

const BATCH = 100;

export const dispatchDueTasks = schedules.task({
  id: "dispatch-due-tasks",
  cron: "*/2 * * * *",
  run: async () => {
    const claimed = await claimDueTasks(BATCH);
    const now = new Date();
    for (const run of claimed) {
      let next: Date | null = null;
      try {
        const schedule = taskScheduleSchema.parse(run.schedule);
        next = nextRunAfter(schedule, run.timezone, new Date(run.scheduledFor), now);
      } catch (e) {
        // A schedule or time zone that can't be read stops the task's schedule, not the dispatch.
        logger.error("couldn't compute the next run", { taskId: run.taskId, error: String(e) });
      }
      await setNextRun(run.taskId, run.scheduledFor, next);
    }

    const queued = claimed.filter((run) => run.runStatus === "queued");
    if (queued.length > 0) {
      await runTask.batchTrigger(
        await Promise.all(
          queued.map(async (run) => ({
            payload: { runId: run.runId, taskId: run.taskId, workspaceId: run.workspaceId, userId: run.userId },
            options: { idempotencyKey: await idempotencyKeys.create(run.runId, { scope: "global" }) },
          })),
        ),
      );
    }
    logger.info("dispatched", { claimed: claimed.length, started: queued.length });
    return { claimed: claimed.length, started: queued.length };
  },
});

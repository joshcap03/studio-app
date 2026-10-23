import { NextResponse, after, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, parseBody } from "@/lib/api";
import { previewEnabled } from "@/lib/flags";
import { appName } from "@/lib/integrations/composio";
import { getTask } from "@/lib/tasks";
import { runClaimedTask, type RunOutcome } from "@/lib/tasks/run-task";
import { capEventData, claimTestEvent, getWatch } from "@/lib/tasks/watches";
import { authorizeTenant, jsonError } from "@/lib/tenant";

// Tries one of the member's watches without its app: feeds it a test event through the same
// claim the worker uses, then runs the run it joined here once its wait is over (the worker's job
// in production). For development and QA only; refused in production builds.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

const body = z.strictObject({
  summary: z.string().trim().min(1).max(200).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  /** Seconds the run waits for more events; 0 starts it now. */
  wait: z.number().int().min(0).max(120).default(0),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Within the route's own time limit, leaving the run room to finish.
const LAST_START = 150_000;

export async function POST(request: NextRequest, { params }: Context) {
  if (process.env.NODE_ENV === "production") return jsonError(404, "Not found.");
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const tenant = auth.value;
  if (!previewEnabled(tenant, "watches")) return jsonError(404, "Not found.");
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Task not found.");
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;

  try {
    const [task, watch] = await Promise.all([getTask(tenant, id.data), getWatch(tenant, id.data)]);
    if (!task) return jsonError(404, "Task not found.");
    if (!watch) return jsonError(404, "This task isn't watching anything.");
    const data = capEventData(input.data ?? { note: "A test event from Studio." });
    const event = {
      id: `test_${crypto.randomUUID()}`,
      at: new Date().toISOString(),
      summary: input.summary ?? `Test event in ${appName(watch.toolkit)}`,
      data,
    };
    const claimed = await claimTestEvent(tenant, watch.id, event, input.wait);
    if (!claimed) return jsonError(409, "This watch is off: its task isn't active, or it needs setting up again.", "not_watching");
    if (claimed.start) {
      const started = Date.now();
      after(async () => {
        // The worker's loop, in one process: wait, ask, and wait again while the run says to.
        let outcome: RunOutcome = { status: "queued", reason: null, retryAt: claimed.notBefore };
        while (outcome.status === "queued" && outcome.retryAt !== undefined && outcome.retryAt - started < LAST_START) {
          await sleep(Math.max(0, outcome.retryAt - Date.now()));
          outcome = await runClaimedTask(tenant, { taskId: task.id, runId: claimed.runId });
        }
      });
    }
    return NextResponse.json({ runId: claimed.runId, started: claimed.start, notBefore: claimed.notBefore }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}

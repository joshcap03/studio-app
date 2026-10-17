import { NextResponse, after, type NextRequest } from "next/server";
import { z } from "zod";
import { agentEnabledFor } from "@/lib/agent";
import { errorResponse } from "@/lib/api";
import { buildTurnDeps } from "@/lib/chat/run";
import { storeFor } from "@/lib/chat/store-for";
import { TurnError, startTurn } from "@/lib/chat/turn";
import { previewEnabled } from "@/lib/flags";
import { appendRun, getTask, markTaskRan, settleRun, updateTask } from "@/lib/tasks";
import { authorizeTenant, jsonError } from "@/lib/tenant";

// Runs one of the member's tasks now, in the background: its brief goes to the agent in the
// task's own conversation (made on the first run), and the member watches it there. Answers
// right away; the run keeps going after the response, like a chat whose tab was closed.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const tenant = auth.value;
  if (!previewEnabled(tenant, "tasks")) return jsonError(404, "Not found.");
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Task not found.");
  if (!agentEnabledFor(tenant.workspace.id)) {
    return jsonError(403, "The agent isn't enabled for this workspace yet.", "agent_unavailable");
  }

  let runId: string | null = null;
  try {
    const task = await getTask(tenant, id.data);
    if (!task) return jsonError(404, "Task not found.");
    let conversationId = task.conversationId;
    if (!conversationId) {
      conversationId = crypto.randomUUID();
      await storeFor(tenant).createConversation({ id: conversationId, title: task.title });
      await updateTask(tenant, task.id, { conversationId });
    }
    const run = await appendRun(tenant, task.id, { scheduledFor: new Date(), status: "running" });
    runId = run?.id ?? null;

    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    const { deps, request: turn } = await buildTurnDeps(tenant, {
      conversationId,
      input: { kind: "task", taskId: task.id, runId },
      onFinished: async (message, _conversation, { report }) => {
        try {
          if (runId) {
            // A run waiting on the member's approval isn't over: approving continues it.
            const status = message.status === "complete" ? "done" : message.status === "awaiting" ? "running" : "failed";
            const reason = message.status === "complete" ? (report?.outcome ?? null) : message.status === "awaiting" ? "waiting_on_you" : message.status;
            await settleRun(tenant, runId, { status, reason, messageId: message.id });
          }
          await markTaskRan(tenant, task.id);
        } catch (e) {
          console.error("[tasks] couldn't record the run's outcome", e);
        } finally {
          settle();
        }
      },
    });
    const stream = await startTurn(deps, turn);
    // No one reads this response's stream: the member follows the run in its conversation.
    void stream.cancel();
    after(() => settled);
    return NextResponse.json({ conversationId, runId }, { status: 202 });
  } catch (error) {
    if (runId) {
      const reason = error instanceof TurnError ? error.message : "The run couldn't start.";
      await settleRun(tenant, runId, { status: error instanceof TurnError && error.status === 429 ? "skipped" : "failed", reason }).catch(() => undefined);
    }
    if (error instanceof TurnError) return jsonError(error.status, error.message, error.status === 429 ? "rate_limited" : undefined);
    return errorResponse(error);
  }
}

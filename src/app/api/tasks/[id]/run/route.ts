import { NextResponse, after, type NextRequest } from "next/server";
import { z } from "zod";
import { agentEnabledFor } from "@/lib/agent";
import { errorResponse } from "@/lib/api";
import { TurnError } from "@/lib/chat/turn";
import { getTask } from "@/lib/tasks";
import { startTaskRun } from "@/lib/tasks/run-task";
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
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Task not found.");
  if (!agentEnabledFor(tenant.workspace.id)) {
    return jsonError(403, "This agent isn't enabled yet.", "agent_unavailable");
  }

  try {
    const task = await getTask(tenant, id.data);
    if (!task) return jsonError(404, "Task not found.");
    const { conversationId, runId, settled } = await startTaskRun(tenant, task);
    after(() => settled);
    return NextResponse.json({ conversationId, runId }, { status: 202 });
  } catch (error) {
    if (error instanceof TurnError) return jsonError(error.status, error.message, error.status === 429 ? "rate_limited" : undefined);
    return errorResponse(error);
  }
}

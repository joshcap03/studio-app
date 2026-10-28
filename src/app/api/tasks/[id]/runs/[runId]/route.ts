import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api";
import { continueClaimedTask, runClaimedTask } from "@/lib/tasks/run-task";
import { authorizeWorker, jsonError } from "@/lib/tenant";

// Starts a run the scheduler already queued, for the background worker (trigger/run-task.ts).
// The worker signs in as the task's member and sends that session's access token; this is one of
// the two routes that take one in a header (the other carries on a chat reply's job), and all it
// can do is start one of that member's own queued runs, or carry on one of theirs that ran out of
// time with more to do. The run then happens here, with the app's own settings and keys, exactly
// like "Run now": as the member, under RLS. Answers with how the run ended.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Context = { params: Promise<{ id: string; runId: string }> };

export async function POST(request: NextRequest, { params }: Context) {
  if (!request.headers.get("authorization")) return jsonError(401, "Not signed in.");
  const { id, runId } = await params;
  const ids = z.object({ id: z.uuid(), runId: z.uuid() }).safeParse({ id, runId });
  const workspace = z.uuid().safeParse(request.nextUrl.searchParams.get("workspace"));
  if (!ids.success || !workspace.success) return jsonError(404, "Run not found.");

  // The run's workspace, honored only if they're still a member of it.
  const auth = await authorizeWorker(request, workspace.data, "Run not found.");
  if (!auth.ok) return auth.response;
  const tenant = auth.value;

  try {
    // ?continue=1: carry on a run whose latest reply ran out of time with more to do.
    const claimed = { taskId: ids.data.id, runId: ids.data.runId };
    const outcome = request.nextUrl.searchParams.get("continue") === "1" ? await continueClaimedTask(tenant, claimed) : await runClaimedTask(tenant, claimed);
    return NextResponse.json(outcome);
  } catch (e) {
    return errorResponse(e);
  }
}

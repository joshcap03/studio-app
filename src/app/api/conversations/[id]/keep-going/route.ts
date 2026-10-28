import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api";
import { continueKeptReply } from "@/lib/chat/run";
import { authorizeWorker, jsonError } from "@/lib/tenant";

// Carries on a chat reply's job (keep_going) with no page open, for the background worker
// (trigger/continue-chat.ts). The worker signs in as the conversation's member and sends that
// session's access token; this is one of the two routes that take one in a header (the other
// starts a task's run), and all it can do is carry on that member's own reply, while it's still
// its conversation's latest and still carrying the job on, in the next reply, exactly as their
// page would: as the member, under RLS, within the cap. Answers once that reply ends.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Context) {
  if (!request.headers.get("authorization")) return jsonError(401, "Not signed in.");
  const query = z
    .object({ id: z.uuid(), workspace: z.uuid(), reply: z.uuid() })
    .safeParse({ id: (await params).id, workspace: request.nextUrl.searchParams.get("workspace"), reply: request.nextUrl.searchParams.get("reply") });
  if (!query.success) return jsonError(404, "Conversation not found.");

  // The conversation's workspace, honored only if they're still a member of it.
  const auth = await authorizeWorker(request, query.data.workspace, "Conversation not found.");
  if (!auth.ok) return auth.response;

  try {
    return NextResponse.json(await continueKeptReply(auth.value, query.data.id, query.data.reply));
  } catch (e) {
    return errorResponse(e);
  }
}

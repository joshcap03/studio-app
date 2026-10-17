import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api";
import { storeFor } from "@/lib/chat/store-for";
import { stopRun } from "@/lib/chat/turn";
import { requestStop } from "@/lib/tasks";
import { authorizeTenant, jsonError } from "@/lib/tenant";

/** Stops the agent working in one of the caller's conversations. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Conversation not found.");
  try {
    // Only the caller's own conversation can be stopped.
    if (!(await storeFor(auth.value).getConversation(id.data))) return jsonError(404, "Conversation not found.");
    // A task's run may be on another server or in the background worker: it sees this flag.
    if (!stopRun(auth.value.workspace.id, id.data)) await requestStop(auth.value, id.data);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

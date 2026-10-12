import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, noStore, parseBody } from "@/lib/api";
import { storeFor } from "@/lib/chat/store-for";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { MAX_TITLE_LENGTH } from "@/lib/types";

type Context = { params: Promise<{ id: string }> };

const id = z.uuid();
const patch = z.object({ title: z.string().trim().min(1, "Enter a title.").max(MAX_TITLE_LENGTH) });

// A conversation id that doesn't belong to the caller's workspace and account is
// indistinguishable from one that doesn't exist: always 404.

export async function GET(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const parsed = id.safeParse((await params).id);
  if (!parsed.success) return jsonError(404, "Conversation not found.");
  try {
    const store = storeFor(auth.value);
    const conversation = await store.getConversation(parsed.data);
    if (!conversation) return jsonError(404, "Conversation not found.");
    const { agentProvider: _p, agentThreadId: _t, ...summary } = conversation;
    return NextResponse.json({ conversation: summary, messages: await store.listMessages(conversation.id) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const parsedId = id.safeParse((await params).id);
  if (!parsedId.success) return jsonError(404, "Conversation not found.");
  const body = await parseBody(request, patch);
  if (body instanceof NextResponse) return body;
  try {
    const conversation = await storeFor(auth.value).renameConversation(parsedId.data, body.title);
    if (!conversation) return jsonError(404, "Conversation not found.");
    return NextResponse.json({ conversation });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const parsedId = id.safeParse((await params).id);
  if (!parsedId.success) return jsonError(404, "Conversation not found.");
  try {
    if (!(await storeFor(auth.value).deleteConversation(parsedId.data))) return jsonError(404, "Conversation not found.");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

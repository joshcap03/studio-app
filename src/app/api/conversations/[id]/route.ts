import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authorize, jsonError } from "@/lib/auth/server";
import { withLiveStatus } from "@/lib/chat/turn";
import { getStore } from "@/lib/db/store";
import { MAX_TITLE_LENGTH } from "@/lib/types";

type Context = { params: Promise<{ id: string }> };

const id = z.uuid();
const patch = z.object({ title: z.string().trim().min(1).max(MAX_TITLE_LENGTH) });

export async function GET(request: NextRequest, { params }: Context) {
  const auth = await authorize(request);
  if (!auth.ok) return auth.response;
  const parsed = id.safeParse((await params).id);
  if (!parsed.success) return jsonError(404, "Conversation not found.");
  const store = getStore();
  const conversation = store.getConversation(auth.userId, parsed.data);
  if (!conversation) return jsonError(404, "Conversation not found.");
  const messages = withLiveStatus(store.listMessages(conversation.id), conversation.id);
  return NextResponse.json(
    { conversation: { id: conversation.id, title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt }, messages },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PATCH(request: NextRequest, { params }: Context) {
  const auth = await authorize(request);
  if (!auth.ok) return auth.response;
  const parsedId = id.safeParse((await params).id);
  if (!parsedId.success) return jsonError(404, "Conversation not found.");
  const body = patch.safeParse(await request.json().catch(() => null));
  if (!body.success) return jsonError(400, "Enter a title.");
  const conversation = getStore().renameConversation(auth.userId, parsedId.data, body.data.title);
  if (!conversation) return jsonError(404, "Conversation not found.");
  return NextResponse.json({ conversation });
}

export async function DELETE(request: NextRequest, { params }: Context) {
  const auth = await authorize(request);
  if (!auth.ok) return auth.response;
  const parsedId = id.safeParse((await params).id);
  if (!parsedId.success) return jsonError(404, "Conversation not found.");
  if (!getStore().deleteConversation(auth.userId, parsedId.data)) return jsonError(404, "Conversation not found.");
  return new NextResponse(null, { status: 204 });
}

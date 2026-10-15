import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAgentAdapter } from "@/lib/agent";
import { errorResponse, noStore, parseBody } from "@/lib/api";
import { removeAttachmentFiles } from "@/lib/attachments";
import { storeFor } from "@/lib/chat/store-for";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { getProject } from "@/lib/projects";
import { MAX_TITLE_LENGTH, type ConversationSummary } from "@/lib/types";

type Context = { params: Promise<{ id: string }> };

const id = z.uuid();
const patch = z
  .object({
    title: z.string().trim().min(1, "Enter a title.").max(MAX_TITLE_LENGTH).optional(),
    // One of the caller's projects to move it into, or null to take it out of its project.
    projectId: z.uuid().nullable().optional(),
  })
  .refine((p) => p.title !== undefined || p.projectId !== undefined, "Nothing to change.");

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
    const store = storeFor(auth.value);
    let conversation: ConversationSummary | null = null;
    if (body.projectId !== undefined) {
      if (body.projectId && !(await getProject(auth.value, body.projectId))) return jsonError(404, "Project not found.");
      conversation = await store.moveConversation(parsedId.data, body.projectId);
      if (!conversation) return jsonError(404, "Conversation not found.");
    }
    if (body.title !== undefined) conversation = await store.renameConversation(parsedId.data, body.title);
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
    const store = storeFor(auth.value);
    const [paths, pending] = await Promise.all([store.attachmentPaths(parsedId.data), store.pendingApproval(parsedId.data)]);
    if (!(await store.deleteConversation(parsedId.data))) return jsonError(404, "Conversation not found.");
    await removeAttachmentFiles(auth.value, paths);
    const adapter = getAgentAdapter();
    if (pending && pending.provider === adapter.id) await adapter.discard?.(pending.providerState).catch(() => undefined);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

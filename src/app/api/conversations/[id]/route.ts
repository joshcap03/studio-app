import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAgentAdapter } from "@/lib/agent";
import { errorResponse, noStore, parseBody } from "@/lib/api";
import { removeAttachmentFiles } from "@/lib/attachments";
import { markCovered } from "@/lib/chat/run";
import { storeFor } from "@/lib/chat/store-for";
import { unknownCards, withoutCards } from "@/lib/chat/ui";
import type { Conversation } from "@/lib/db/store";
import { journeyOrNone } from "@/lib/journey";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { getProject } from "@/lib/projects";
import { MAX_TITLE_LENGTH, type ConversationSummary } from "@/lib/types";
import { messagesWithCalls } from "@/lib/voice/calls";

type Context = { params: Promise<{ id: string }> };

const id = z.uuid();
const patch = z
  .object({
    title: z.string().trim().min(1, "Enter a title.").max(MAX_TITLE_LENGTH).optional(),
    // One of the caller's projects to move it into, or null to take it out of its project.
    projectId: z.uuid().nullable().optional(),
    // Null clears the plan the agent keeps for the work here, and what done means (the rail
    // above the chat). A task's plan is changed on the task, and the setup's by the interview.
    plan: z.null().optional(),
  })
  .refine((p) => p.title !== undefined || p.projectId !== undefined || p.plan !== undefined, "Nothing to change.");

// A conversation id that doesn't belong to the caller's workspace and account is
// indistinguishable from one that doesn't exist: always 404.

/** A conversation as the browser sees it, without the agent provider's thread. */
function summaryOf({ agentProvider: _p, agentThreadId: _t, ...summary }: Conversation): ConversationSummary {
  return summary;
}

export async function GET(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const parsed = id.safeParse((await params).id);
  if (!parsed.success) return jsonError(404, "Conversation not found.");
  try {
    const store = storeFor(auth.value);
    const conversation = await store.getConversation(parsed.data);
    if (!conversation) return jsonError(404, "Conversation not found.");
    // The plan of the work here comes with it, so a run followed from elsewhere fills in the rail
    // too, and so do the calls its messages were said on (for their recaps).
    const [listed, journey] = await Promise.all([store.listMessages(conversation.id), journeyOrNone(auth.value, conversation.id)]);
    const withCalls = await messagesWithCalls(auth.value, listed);
    const { calls } = withCalls;
    // A request the member's standing OK covers is being approved by the run itself.
    const messages = await markCovered(auth.value, conversation.id, withCalls.messages);
    // Offers to call (?offers=1), requests for a login or card (?secrets=1), and the browser
    // handed over (?handoffs=1) only go to pages that know them: a tab still on older code breaks on one.
    const params = request.nextUrl.searchParams;
    const shown = withoutCards(messages, unknownCards({ offers: params.get("offers") === "1", secrets: params.get("secrets") === "1", handoffs: params.get("handoffs") === "1" }));
    return NextResponse.json({ conversation: summaryOf(conversation), messages: shown, journey, calls }, noStore);
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
    if (body.plan === null) {
      if (!(await store.savePlan(parsedId.data, { steps: [], goal: null }))) return jsonError(404, "Conversation not found.");
      conversation ??= await store.getConversation(parsedId.data).then((c) => (c ? summaryOf(c) : null));
    }
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

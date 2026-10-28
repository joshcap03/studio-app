import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, noStore } from "@/lib/api";
import { markCovered } from "@/lib/chat/run";
import { storeFor } from "@/lib/chat/store-for";
import { shownTo } from "@/lib/chat/ui";
import { journeyOrNone } from "@/lib/journey";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { MESSAGE_PAGE } from "@/lib/types";
import { messagesWithCalls } from "@/lib/voice/calls";

// What changed in a conversation since the page last looked, for following a run this tab isn't
// streaming (a task's run, the worker's, or one it let go of while hidden). `from` is the message
// the page has last: it comes back as it stands now, with everything after it, rather than the
// whole conversation every second and a half. When that message is gone (a retry replaced it, an
// edit cut it), the newest page comes back with `reset`, as the conversation itself would load.

type Context = { params: Promise<{ id: string }> };

const id = z.uuid();

export async function GET(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const parsed = id.safeParse((await params).id);
  const from = id.safeParse(request.nextUrl.searchParams.get("from"));
  if (!parsed.success) return jsonError(404, "Conversation not found.");
  if (!from.success) return jsonError(400, "Say which message the page has last.");
  try {
    const store = storeFor(auth.value);
    const conversation = await store.getConversation(parsed.data);
    if (!conversation) return jsonError(404, "Conversation not found.");
    const [since, journey] = await Promise.all([store.messagesSince(conversation.id, from.data), journeyOrNone(auth.value, conversation.id)]);
    const page = since ? null : await store.pageMessages(conversation.id, { limit: MESSAGE_PAGE });
    const withCalls = await messagesWithCalls(auth.value, since ?? page!.messages);
    // A request the member's standing OK covers is being approved by the run itself.
    const messages = shownTo(request.nextUrl.searchParams, await markCovered(auth.value, conversation.id, withCalls.messages));
    const { agentProvider: _p, agentThreadId: _t, ...summary } = conversation;
    return NextResponse.json(
      { conversation: summary, messages, journey, calls: withCalls.calls, ...(page ? { reset: true, earlier: page.earlier } : {}) },
      noStore,
    );
  } catch (error) {
    return errorResponse(error);
  }
}

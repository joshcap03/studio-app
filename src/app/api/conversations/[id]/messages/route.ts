import type { NextRequest } from "next/server";
import { z } from "zod";
import { getAgentAdapter } from "@/lib/agent";
import { authorize, jsonError } from "@/lib/auth/server";
import { TurnError, startTurn } from "@/lib/chat/turn";
import { getConfig } from "@/lib/config";
import { getStore } from "@/lib/db/store";
import { MAX_MESSAGE_LENGTH } from "@/lib/types";

// Starts a turn and streams it back as NDJSON (one StreamEvent per line). Creating the
// conversation on first send lets the browser create conversations optimistically.

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("send"), text: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH) }),
  z.object({ kind: z.literal("retry") }),
]);

export async function POST(request: NextRequest, { params }: Context) {
  const auth = await authorize(request);
  if (!auth.ok) return auth.response;
  const conversationId = z.uuid().safeParse((await params).id);
  if (!conversationId.success) return jsonError(404, "Conversation not found.");
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "Messages must be between 1 and 32,000 characters.");

  try {
    const store = getStore();
    store.ensureUser(auth.userId);
    const stream = startTurn(
      { store, adapter: getAgentAdapter(), idleTimeoutMs: getConfig().agent.idleTimeoutMs },
      { userId: auth.userId, conversationId: conversationId.data, ...parsed.data },
      request.signal,
    );
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof TurnError) return jsonError(error.status, error.message);
    throw error;
  }
}

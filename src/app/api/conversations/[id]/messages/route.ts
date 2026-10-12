import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAgentAdapter } from "@/lib/agent";
import { errorResponse, parseBody } from "@/lib/api";
import { storeFor } from "@/lib/chat/store-for";
import { TurnError, startTurn } from "@/lib/chat/turn";
import { getConfig } from "@/lib/config";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { MAX_MESSAGE_LENGTH } from "@/lib/types";
import { buildAgentContext, checkRunLimits, recordRun } from "@/lib/workspace";

// Starts a turn and streams it back as NDJSON (one StreamEvent per line). Creating the
// conversation on first send lets the browser create conversations optimistically. The
// workspace, user, and agent context all come from the session, never from the request.

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("send"), text: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH) }),
  z.object({ kind: z.literal("retry") }),
]);

export async function POST(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const tenant = auth.value;
  const conversationId = z.uuid().safeParse((await params).id);
  if (!conversationId.success) return jsonError(404, "Conversation not found.");
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;

  try {
    const limit = await checkRunLimits(tenant);
    if (limit) return jsonError(429, limit, "rate_limited");

    const store = storeFor(tenant);
    // A conversation id that exists for another tenant fails here: the insert collides with
    // a row this tenant cannot see, and the database refuses it.
    const stream = await startTurn(
      {
        store,
        adapter: getAgentAdapter(),
        context: await buildAgentContext(tenant),
        idleTimeoutMs: getConfig().agent.idleTimeoutMs,
      },
      { conversationId: conversationId.data, ...input },
      request.signal,
    );
    await recordRun(tenant);
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof TurnError) return jsonError(error.status, error.message);
    if (/duplicate key|violates/.test((error as Error)?.message ?? "")) return jsonError(404, "Conversation not found.");
    return errorResponse(error);
  }
}

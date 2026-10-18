import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeSession, jsonError } from "@/lib/tenant";
import { frontRequest, mockReply, modelStream, planReply, replyStream } from "@/lib/voice/front";
import { openContext } from "@/lib/voice/seal";

// The voice front (see src/lib/voice/front.ts): the model behind a call's voice. ElevenLabs
// calls it with the custom-LLM key and two headers it fills per call, the conversation id and
// the sealed voice context; there's no member session here, and no database access. Under the
// mock voice the member's own browser calls it instead, with their session.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SSE = { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" };

function bearerMatches(header: string | null, secret: string): boolean {
  const given = Buffer.from(/^Bearer\s+(.+)$/i.exec(header ?? "")?.[1]?.trim() ?? "");
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function POST(request: NextRequest) {
  const voice = getConfig().voice;
  if (!voice) return jsonError(404, "Not found.");
  const context = openContext(request.headers.get("x-studio-voice-ctx"), request.headers.get("x-studio-conversation"), voice.sealSecret);
  if (!context || context.provider !== voice.provider) return jsonError(401, "Not authorized.");

  if (voice.provider === "elevenlabs") {
    if (!bearerMatches(request.headers.get("authorization"), voice.llmSecret!)) return jsonError(401, "Not authorized.");
  } else {
    const auth = await authorizeSession(request);
    if (!auth.ok) return auth.response;
    if (auth.value.userId !== context.uid) return jsonError(401, "Not authorized.");
  }

  const parsed = frontRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "Invalid request.");

  const plan = planReply(context, parsed.data.messages);
  if (plan.kind === "say") return new Response(replyStream({ text: plan.text }), { headers: SSE });
  if (plan.kind === "skip") {
    // Silence: the provider's skip_turn when it offers one, else an empty reply.
    const canSkip = !parsed.data.tools?.length || parsed.data.tools.some((t) => t.function.name === "skip_turn");
    return new Response(replyStream(canSkip ? { tools: [{ name: "skip_turn", args: { reason: "Nothing new to say" } }] } : {}), { headers: SSE });
  }
  const body = voice.llm ? await modelStream(voice.llm, context, parsed.data, request.signal) : replyStream(mockReply(parsed.data.messages));
  return new Response(body, { headers: SSE });
}

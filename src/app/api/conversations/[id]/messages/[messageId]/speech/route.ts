import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api";
import { storeFor } from "@/lib/chat/store-for";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { voiceStatus } from "@/lib/voice";
import { sayNote } from "@/lib/voice/clips";
import { resolvePersona } from "@/lib/voice/persona";
import { SpeechUnavailable } from "@/lib/voice/speech";

// One of the caller's replies as its voice note: the note's words (saved with the reply when it
// finished), said in the voice this member chose for the agent. Made on each play that reaches
// here, charged to their voice time, and sent straight back, never stored; their browser keeps
// it for a day, so playing it again there is free. Charging is a change, so another site's
// <audio> or link can't ask for it.

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; messageId: string }> };

export async function GET(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request, { writes: true });
  if (!auth.ok) return auth.response;
  const ids = z.object({ id: z.uuid(), messageId: z.uuid() }).safeParse(await params);
  if (!ids.success) return jsonError(404, "Not found.");
  if (!voiceStatus(auth.value)?.speech.tts) return jsonError(404, "Not found.");
  try {
    const message = await storeFor(auth.value).getMessage(ids.data.id, ids.data.messageId);
    if (message?.role !== "assistant" || !message.voiceNote) return jsonError(404, "Not found.");
    const persona = await resolvePersona(auth.value);
    const said = await sayNote(auth.value, message.id, message.voiceNote, persona.voice);
    if (!said.ok) return jsonError(429, "You've used today's voice time. It resets at midnight UTC; the words are here.", "voice_daily");
    const { audio, type } = said.speech;
    return new NextResponse(new Blob([audio as BlobPart], { type }), {
      headers: { "Content-Type": type, "Content-Length": String(audio.byteLength), "Cache-Control": "private, max-age=86400" },
    });
  } catch (error) {
    if (error instanceof SpeechUnavailable) {
      console.error("[voice] couldn't say a voice note", error.cause instanceof Error ? error.cause.message : error.message);
      return jsonError(503, "Voice notes are unavailable right now; the words are here.", "voice_unavailable");
    }
    return errorResponse(error);
  }
}

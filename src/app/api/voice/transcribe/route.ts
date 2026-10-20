import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, noStore } from "@/lib/api";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { voiceStatus } from "@/lib/voice";
import { hearRecording } from "@/lib/voice/clips";
import { MAX_RECORDING_BYTES } from "@/lib/voice/mic";
import { SpeechUnavailable } from "@/lib/voice/speech";

// What the member said into the message box's mic (a held voice message, or dictation), as
// text. The recording is the raw request body, charged to their daily voice time, sent to the
// speech provider, and dropped: nothing is stored or logged. The words go back to the browser,
// which sends them (or puts them in the draft) like typing. The mic stops at two minutes, and so
// does this: the body's size caps it at any rate a browser records speech, and the provider's
// own measure of a longer one gets no words back (src/lib/voice/clips.ts).

export const dynamic = "force-dynamic";

/** What browsers' recorders make (Opus in WebM or Ogg, AAC in MP4), and little else. */
const TYPES = new Set(["audio/webm", "audio/mp4", "audio/ogg", "audio/mpeg", "audio/wav"]);

export async function POST(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  if (!voiceStatus(auth.value)?.speech.stt) return jsonError(404, "Not found.");
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!TYPES.has(type)) return jsonError(415, "Send a recording.");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RECORDING_BYTES) return tooLong();
  const audio = await readCapped(request, MAX_RECORDING_BYTES);
  if (!audio) return tooLong();
  if (audio.byteLength === 0) return jsonError(400, "Send a recording.");
  try {
    const heard = await hearRecording(auth.value, audio, type);
    if (!heard.ok && heard.refused === "long") return tooLong();
    if (!heard.ok) return jsonError(429, "You've used today's voice time. It resets at midnight UTC; you can type instead.", "voice_daily");
    return NextResponse.json({ text: heard.text, ...(heard.mock ? { mock: true } : {}) }, noStore);
  } catch (error) {
    if (error instanceof SpeechUnavailable) {
      console.error("[voice] couldn't hear a recording", error.cause instanceof Error ? error.cause.message : error.message);
      return jsonError(503, "Couldn't hear that just now. Try again, or type it.", "voice_unavailable");
    }
    return errorResponse(error);
  }
}

const tooLong = () => jsonError(413, "That recording is too long. Keep it under two minutes.");

/** The body, or null once it runs past `max` bytes (the rest isn't read). */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const audio = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    audio.set(part, at);
    at += part.byteLength;
  }
  return audio;
}

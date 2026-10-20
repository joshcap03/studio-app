import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { claimVoiceClip, voiceStatus } from "@/lib/voice";
import { PREVIEW_LINE, previewRef, previewSpeech } from "@/lib/voice/preview";
import { speechSeconds, SpeechUnavailable } from "@/lib/voice/speech";
import { isVoiceKey } from "@/lib/voice/voices";

// How one of Studio's voices sounds, for the member choosing one: a fixed line the server wrote,
// in the voice they named (a key from the catalog, nothing else). Charged to their daily voice
// time once per voice a day, so another site can't ask for one; under the mock voice it's a
// short tone. Nothing is stored.

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request, { writes: true });
  if (!auth.ok) return auth.response;
  if (!voiceStatus(auth.value)) return jsonError(404, "Not found.");
  const voice = request.nextUrl.searchParams.get("voice");
  if (!isVoiceKey(voice)) return jsonError(400, "Pick one of the voices.");
  try {
    const claim = await claimVoiceClip(auth.value, { kind: "preview", ref: previewRef(voice), seconds: speechSeconds(PREVIEW_LINE) });
    if (!claim.ok) return jsonError(429, "You've used today's voice time. It resets at midnight UTC.", "voice_daily");
    const speech = await previewSpeech(voice);
    return new NextResponse(new Blob([speech.audio as BlobPart], { type: speech.type }), {
      headers: {
        "Content-Type": speech.type,
        "Content-Length": String(speech.audio.byteLength),
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch (error) {
    if (error instanceof SpeechUnavailable) {
      console.error("[voice] couldn't make a preview", error);
      return jsonError(503, "Previews are unavailable right now. Try again in a bit.", "voice_unavailable");
    }
    return errorResponse(error);
  }
}

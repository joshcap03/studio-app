import { type NextRequest, NextResponse } from "next/server";
import { errorResponse, noStore } from "@/lib/api";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { startVoiceCall, voiceStatus, VoiceUnavailable } from "@/lib/voice";

// Starts a voice call (the Setup Call preview) for the signed-in member: claims a call against
// their daily voice time, opens it with the provider, and seals the call's voice context (their
// guardrail first, the agent's persona) for the voice front. The member and agent come from the
// session; the body is ignored.

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  if (!voiceStatus(auth.value)) return jsonError(404, "Not found.");
  try {
    const started = await startVoiceCall(auth.value);
    if (!started.ok) return jsonError(429, "You've used today's voice time. It resets at midnight UTC; you can keep going here in text.", "voice_daily");
    return NextResponse.json({ grant: started.grant }, { status: 201, ...noStore });
  } catch (error) {
    if (error instanceof VoiceUnavailable) {
      console.error("[voice] couldn't start a call", error);
      return jsonError(503, "Voice is unavailable right now. Keep going here.", "voice_unavailable");
    }
    return errorResponse(error);
  }
}

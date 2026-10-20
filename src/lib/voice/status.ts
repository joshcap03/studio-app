import { getConfig } from "@/lib/config";
import { previewEnabled } from "@/lib/flags";
import type { Session } from "@/lib/tenant-core";
import { ELEVENLABS_LABEL } from "./elevenlabs";
import { MOCK_VOICE_LABEL } from "./mock";
import { SPEECH_CAPABILITIES } from "./speech";
import type { VoiceStatus } from "./types";

// Whether voice is on for one member, on its own so the agent's context (src/lib/workspace.ts)
// can ask without importing the call code, which reads that context.

/** Whether this member can call, and what speech works: null when voice is off for them. */
export function voiceStatus(tenant: Pick<Session, "email">): VoiceStatus | null {
  const voice = getConfig().voice;
  if (!voice || !previewEnabled(tenant, "voice")) return null;
  return voice.provider === "mock"
    ? { provider: "mock", label: MOCK_VOICE_LABEL, live: false, speech: SPEECH_CAPABILITIES.mock }
    : { provider: "elevenlabs", label: ELEVENLABS_LABEL, live: true, speech: SPEECH_CAPABILITIES.elevenlabs };
}

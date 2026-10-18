import type { VoiceCapabilities, VoiceJoin } from "./types";

// ElevenLabs Agents, server side: opening a call mints a short-lived WebRTC conversation token
// for one shared agent set to custom-LLM mode (its model is Studio's voice front). The API key
// never leaves the server; the browser gets only the token. The token endpoint takes no
// overrides, so nothing about the member travels here: their context is sealed separately.
// See docs/voice.md for the agent's settings.

export const ELEVENLABS_LABEL = "ElevenLabs";

export const ELEVENLABS_CAPABILITIES: VoiceCapabilities = { audio: true, bargeIn: true, verbatimTranscripts: true };

export class VoiceUnavailable extends Error {}

export async function openElevenLabsCall(config: { apiKey: string; agentId: string }): Promise<{ conversationId: string; join: VoiceJoin }> {
  const url = new URL("https://api.elevenlabs.io/v1/convai/conversation/token");
  url.searchParams.set("agent_id", config.agentId);
  let res: Response;
  try {
    res = await fetch(url, { headers: { "xi-api-key": config.apiKey }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new VoiceUnavailable("ElevenLabs didn't answer.", { cause: e });
  }
  if (!res.ok) throw new VoiceUnavailable(`ElevenLabs refused the call (${res.status}).`);
  const body = (await res.json().catch(() => null)) as { token?: unknown; conversation_id?: unknown } | null;
  if (typeof body?.token !== "string" || typeof body.conversation_id !== "string" || !body.token || !body.conversation_id) {
    throw new VoiceUnavailable("ElevenLabs sent no conversation token.");
  }
  return { conversationId: body.conversation_id, join: { kind: "elevenlabs", conversationToken: body.token } };
}

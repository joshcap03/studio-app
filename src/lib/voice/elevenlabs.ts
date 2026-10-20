import type { VoiceCapabilities, VoiceJoin } from "./types";
import type { VoiceKey } from "./voices";

// ElevenLabs, server side. Opening a call mints a short-lived WebRTC conversation token for one
// shared agent set to custom-LLM mode (its model is Studio's voice front). Speech outside calls
// (a voice preview, a voice note, a member's voice message) uses its text-to-speech and
// speech-to-text APIs. The API key never leaves the server; the browser gets only the token or
// the audio. The token endpoint takes no overrides, so nothing about the member travels here:
// their context is sealed separately. See docs/voice.md for the agent's settings.

export const ELEVENLABS_LABEL = "ElevenLabs";

export const ELEVENLABS_CAPABILITIES: VoiceCapabilities = { audio: true, bargeIn: true, verbatimTranscripts: true };

const API = "https://api.elevenlabs.io/v1";

/**
 * Studio's voices (src/lib/voice/voices.ts) as ElevenLabs premade voices. The only place a
 * voice key becomes a provider id. scripts/voice-agent.mjs checks each one exists on the account.
 */
export const ELEVENLABS_VOICES: Record<VoiceKey, string> = {
  steady: "SAz9YHcvj6GT2YYXdXww",
  clear: "Xb7hH8MSUJpSbSDYk0k2",
  easygoing: "cjVigY5qzO86Huf0OWal",
  warm: "XrExE9yKIg1WjnnlVkGX",
  bright: "cgSgspJ2msm6clMCkdW9",
  grounded: "JBFqnCBsd6RMkjVDRZzb",
  casual: "iP95p4xoKVk53GoZ742B",
  gentle: "EXAVITQu4vr4xnSDxMaL",
};

/**
 * The text-to-speech model for speech outside calls, the same one the call agent speaks with
 * (scripts/voice-agent.mjs sets it), so a preview sounds like the call. English only, like the agent.
 */
export const ELEVENLABS_TTS_MODEL = "eleven_flash_v2";
export const ELEVENLABS_STT_MODEL = "scribe_v2";

export class VoiceUnavailable extends Error {}

export async function openElevenLabsCall(config: { apiKey: string; agentId: string }): Promise<{ conversationId: string; join: VoiceJoin }> {
  const url = new URL(`${API}/convai/conversation/token`);
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

/** `text` in `voice`, as MP3 bytes. Throws when ElevenLabs doesn't answer or refuses. */
export async function elevenLabsSpeak(apiKey: string, voice: VoiceKey, text: string): Promise<Uint8Array> {
  const url = new URL(`${API}/text-to-speech/${ELEVENLABS_VOICES[voice]}`);
  // Small enough for a phone, clear enough for speech; available on every paid plan.
  url.searchParams.set("output_format", "mp3_44100_64");
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: ELEVENLABS_TTS_MODEL }),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`ElevenLabs refused text to speech (${res.status}).`);
  const audio = new Uint8Array(await res.arrayBuffer());
  if (audio.byteLength === 0) throw new Error("ElevenLabs sent no audio.");
  return audio;
}

/**
 * What the member said in a recording, and how long it ran: the length ElevenLabs measured (what
 * it charges for), else the end of the last thing it timed, so a long silence after a few words
 * still counts. Null when it reports neither. Throws when it doesn't answer or refuses.
 */
export async function elevenLabsTranscribe(apiKey: string, audio: Blob): Promise<{ text: string; seconds: number | null }> {
  const form = new FormData();
  form.set("model_id", ELEVENLABS_STT_MODEL);
  form.set("file", audio, "speech");
  form.set("tag_audio_events", "false");
  form.set("timestamps_granularity", "word");
  const res = await fetch(`${API}/speech-to-text`, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`ElevenLabs refused speech to text (${res.status}).`);
  const body = (await res.json().catch(() => null)) as { text?: unknown; words?: { end?: unknown }[]; audio_duration_secs?: unknown } | null;
  if (typeof body?.text !== "string") throw new Error("ElevenLabs sent no transcript.");
  const timed = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  const ends = (Array.isArray(body.words) ? body.words : []).flatMap((w) => (timed(w?.end) ? [w.end] : []));
  const heard = [...(timed(body.audio_duration_secs) ? [body.audio_duration_secs] : []), ...ends];
  return { text: body.text.trim(), seconds: heard.length ? Math.max(...heard) : null };
}

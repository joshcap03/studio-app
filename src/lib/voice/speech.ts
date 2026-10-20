import { getConfig } from "@/lib/config";
import { elevenLabsSpeak, elevenLabsTranscribe } from "./elevenlabs";
import type { SpeechCapabilities, VoiceProviderId } from "./types";
import type { VoiceKey } from "./voices";

// Speech outside a call, server side: an agent's voice saying a line (a preview, a voice note),
// and a member's recorded words as text (a voice message). The provider's adapter does the work;
// the mock is a labeled stand-in, a short tone and no transcript, so QA needs no provider and
// nothing pretends to be a voice. No audio is ever written anywhere (Storage, logs, the
// database): the bytes go straight back to the member who asked. Callers charge each clip to
// the member's daily voice time first (claimVoiceClip in index.ts).

export class SpeechUnavailable extends Error {}

/** The longest text one clip says: a voice note's script is far shorter. */
export const MAX_SPEECH_CHARS = 1000;

/** What each provider can do outside calls. The mock "speaks" a tone and takes typed words instead. */
export const SPEECH_CAPABILITIES: Record<VoiceProviderId, SpeechCapabilities> = {
  elevenlabs: { tts: true, stt: true },
  mock: { tts: true, stt: true },
};

export interface Speech {
  audio: Uint8Array;
  type: "audio/mpeg" | "audio/wav";
  /** The mock's tone, not a voice. */
  mock: boolean;
}

export interface Transcript {
  text: string;
  /** How long the recording ran, for the member's daily voice time. */
  seconds: number;
  /** The mock hears nothing: the browser asks for typed words instead. */
  mock?: true;
}

/** Roughly how long `text` takes to say, in whole seconds (about 15 characters a second). */
export function speechSeconds(text: string): number {
  return Math.max(1, Math.ceil(text.trim().length / 15));
}

/**
 * Roughly how long a recording runs from its size, when the provider doesn't say: compressed
 * speech is around 32 kbit/s, 4 KB a second.
 */
export function recordingSeconds(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / 4000));
}

/** `text` said in `voice`. Throws SpeechUnavailable when voice is off or the provider fails. */
export async function speak(text: string, voice: VoiceKey): Promise<Speech> {
  const said = text.trim();
  if (!said || said.length > MAX_SPEECH_CHARS) throw new RangeError(`Speech takes 1-${MAX_SPEECH_CHARS} characters.`);
  const config = getConfig().voice;
  if (!config) throw new SpeechUnavailable("Voice isn't set up.");
  if (config.provider === "mock") return { audio: mockTone(), type: "audio/wav", mock: true };
  try {
    return { audio: await elevenLabsSpeak(config.elevenlabs!.apiKey, voice, said), type: "audio/mpeg", mock: false };
  } catch (e) {
    throw new SpeechUnavailable("Couldn't make the audio.", { cause: e });
  }
}

/** What the member said in `audio`. Throws SpeechUnavailable when voice is off or the provider fails. */
export async function transcribe(audio: Uint8Array, mime: string): Promise<Transcript> {
  const config = getConfig().voice;
  if (!config) throw new SpeechUnavailable("Voice isn't set up.");
  if (config.provider === "mock") return { text: "", seconds: 0, mock: true };
  try {
    const heard = await elevenLabsTranscribe(config.elevenlabs!.apiKey, new Blob([audio as BlobPart], { type: mime }));
    return { text: heard.text, seconds: heard.seconds === null ? recordingSeconds(audio.byteLength) : Math.max(1, Math.ceil(heard.seconds)) };
  } catch (e) {
    throw new SpeechUnavailable("Couldn't hear that.", { cause: e });
  }
}

const TONE_RATE = 8000;

/**
 * MOCK VOICE: a soft, falling two-note chime (under a second, 16-bit mono WAV), plainly not
 * a voice, so a preview or a voice note can be played end to end without a provider.
 */
export function mockTone(): Uint8Array {
  const notes = [
    { hz: 660, seconds: 0.35 },
    { hz: 495, seconds: 0.5 },
  ];
  const samples = notes.flatMap(({ hz, seconds }) =>
    Array.from({ length: Math.round(seconds * TONE_RATE) }, (_, i) => {
      const t = i / TONE_RATE;
      // A short attack and an even fade, so it never clicks.
      const envelope = Math.min(1, t / 0.02) * (1 - i / (seconds * TONE_RATE));
      return Math.round(Math.sin(2 * Math.PI * hz * t) * envelope * 0.3 * 32767);
    }),
  );
  const data = samples.length * 2;
  const wav = new DataView(new ArrayBuffer(44 + data));
  const text = (at: number, s: string) => [...s].forEach((c, i) => wav.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  wav.setUint32(4, 36 + data, true);
  text(8, "WAVE");
  text(12, "fmt ");
  wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true);
  wav.setUint16(22, 1, true);
  wav.setUint32(24, TONE_RATE, true);
  wav.setUint32(28, TONE_RATE * 2, true);
  wav.setUint16(32, 2, true);
  wav.setUint16(34, 16, true);
  text(36, "data");
  wav.setUint32(40, data, true);
  samples.forEach((s, i) => wav.setInt16(44 + i * 2, s, true));
  return new Uint8Array(wav.buffer);
}

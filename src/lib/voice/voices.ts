// The voices an agent can speak with on calls (later in voice notes too): Studio's own names for
// how each one sounds. Templates, proposals and members name a voice by its key; only the voice
// provider's adapter (elevenlabs.ts) knows which of its voices that is. Shared with the browser,
// so no runtime imports here.

export interface Voice {
  /** Lowercase slug, stored per member (agent_companions.voice). */
  key: string;
  /** A word or two, in Studio's words, never the provider's name for it. */
  label: string;
  /** How it sounds, in one line. */
  description: string;
}

export const VOICES = [
  { key: "steady", label: "Steady", description: "Relaxed and even, in the middle of the range." },
  { key: "clear", label: "Clear", description: "Crisp and confident, with a British accent." },
  { key: "easygoing", label: "Easygoing", description: "Smooth and friendly, on the lower side." },
  { key: "warm", label: "Warm", description: "Unhurried and kind, with a friendly lift." },
  { key: "bright", label: "Bright", description: "Lively and upbeat, on the higher side." },
  { key: "grounded", label: "Grounded", description: "Deep and calm, with a British accent." },
  { key: "casual", label: "Casual", description: "Down to earth, like a friend talking." },
  { key: "gentle", label: "Gentle", description: "Soft and reassuring, never rushed." },
] as const satisfies readonly Voice[];

export type VoiceKey = (typeof VOICES)[number]["key"];

export const VOICE_KEYS = VOICES.map((v) => v.key) as [VoiceKey, ...VoiceKey[]];

export function isVoiceKey(value: unknown): value is VoiceKey {
  return typeof value === "string" && VOICES.some((v) => v.key === value);
}

/** The catalog as the agent reads it, one voice a line, by id. */
export function voiceMenu(): string {
  return VOICES.map((v) => `- ${v.key}: ${v.label}. ${v.description}`).join("\n");
}

export function voiceByKey(key: string | null | undefined): (typeof VOICES)[number] | undefined {
  return VOICES.find((v) => v.key === key);
}

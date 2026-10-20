import { VOICE_MARKER, type VoiceCue, type VoiceGrant, type VoiceMarker, type VoiceStage, type VoiceToolName } from "@/lib/voice/types";

// The browser's side of a call, whatever the provider: how the call screen talks to the voice,
// and what the voice tells it. Each provider's link implements this (mock-link.ts,
// elevenlabs-link.tsx); the call screen never sees which one is running.

export type LinkStatus = "connecting" | "connected" | "ended" | "error";

export interface VoiceLinkEvents {
  onStatus(status: LinkStatus, message?: string): void;
  onMode(mode: "speaking" | "listening"): void;
  /**
   * What the member said, as the speech-to-text heard it: the words that get handed off. `typed`:
   * typed on the call instead, which never counts as a spoken yes to a request.
   */
  onMemberText(text: string, how: { typed: boolean }): void;
  /** What the voice said, for captions. */
  onVoiceText(text: string): void;
  /** The member talked over the voice, which stopped (or the provider cut what it was saying short). */
  onInterrupted(): void;
  /** How likely it is the member is speaking right now (0 to 1), when the provider reports it. */
  onVoiceActivity?(score: number): void;
}

/** The client tools; each checks what it's asked against the member's own words and says what happened. */
export type VoiceTools = Record<VoiceToolName, (params: Record<string, unknown>) => Promise<string> | string>;

export interface VoiceLink {
  /** Says Studio's lines (relay updates) word for word. */
  say(lines: string[], stage: VoiceStage): void;
  /** Keeps the voice's view of the stage current without saying anything. */
  stage(stage: VoiceStage): void;
  cue(cue: VoiceCue, stage: VoiceStage): void;
  /** Words the member typed on the call, taken like speech (but never as a spoken yes). */
  type(text: string): void;
  /**
   * MOCK VOICE only: words that stand in for the member speaking, as if the speech-to-text heard
   * them, so QA can say "send it" to a request. Real links have no such thing.
   */
  mockSpeech?(text: string): void;
  /** Mutes the member's mic, or the voice's speech (captions carry on). */
  setMuted(what: { mic?: boolean; speaker?: boolean }): void;
  end(): void;
}

export interface LinkProps {
  grant: VoiceGrant;
  events: VoiceLinkEvents;
  tools: VoiceTools;
  onReady: (link: VoiceLink) => void;
}

export function markerText(marker: VoiceMarker): string {
  return `${VOICE_MARKER}${JSON.stringify(marker)}`;
}

export const isMarker = (text: string) => text.trimStart().startsWith(VOICE_MARKER);

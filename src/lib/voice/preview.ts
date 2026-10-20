import { speak, type Speech } from "./speech";
import type { VoiceKey } from "./voices";

// How a voice sounds before the member picks it: one fixed line the server writes (the browser
// never supplies the words, so the preview can't be used to say anything else), the same for
// everyone. Each server instance keeps the few clips in memory, never on disk.

/** Bump with any change to the line, so members hear (and are charged for) the new one. */
export const PREVIEW_VERSION = 1;

export const PREVIEW_LINE = "Hi, this is how I'd sound when we talk on a call: what I found, what's next, and what I need from you.";

/** The clip's name for the member's daily voice time: once per voice and line a day. */
export function previewRef(voice: VoiceKey): string {
  return `preview:${voice}:v${PREVIEW_VERSION}`;
}

const clips = new Map<VoiceKey, Promise<Speech>>();

/** The preview line in `voice`, made once per instance (a failure isn't kept, so the next try asks again). */
export function previewSpeech(voice: VoiceKey): Promise<Speech> {
  let clip = clips.get(voice);
  if (!clip) {
    clip = speak(PREVIEW_LINE, voice);
    clips.set(voice, clip);
    clip.catch(() => clips.delete(voice));
  }
  return clip;
}

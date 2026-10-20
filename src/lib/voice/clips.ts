import { createHash, randomUUID } from "node:crypto";
import type { Tenant } from "@/lib/tenant-core";
import type { VoiceNote } from "@/lib/types";
import { claimVoiceClip, MAX_CLIP_SECONDS } from "./index";
import { MAX_RECORDING_SECONDS } from "./mic";
import { recordingSeconds, speak, speechSeconds, transcribe, type Speech } from "./speech";
import type { VoiceKey } from "./voices";

// Speech outside calls for one member, each clip charged to their daily voice time before it's
// made: a reply's voice note said in the agent's voice, and their own recording turned into
// words. Neither is kept: the audio goes straight back to them, and the recording is dropped once
// it's heard. Every time the provider does the work, it's charged. Server-only.

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** A recording the provider heard running this much past the mic's limit wasn't made by it. */
const LONG_SLACK_SECONDS = 5;

/**
 * A reply's voice note, said in `voice` (the one this member chose for the agent). Each time it's
 * said, it's charged: the browser keeps the clip for a day, so playing it again there costs
 * nothing, and a play that reaches the server again has the voice make it again.
 */
export async function sayNote(
  tenant: Tenant,
  messageId: string,
  note: VoiceNote,
  voice: VoiceKey,
): Promise<{ ok: true; speech: Speech } | { ok: false; refused: "daily" }> {
  // Named by the reply, a hash of what's said and in which voice, and this play; never the words.
  const ref = `${messageId}:${sha256(`${voice}\n${note.script}`)}:${randomUUID()}`;
  const claim = await claimVoiceClip(tenant, { kind: "note", ref, seconds: speechSeconds(note.script) });
  if (!claim.ok) return claim;
  return { ok: true, speech: await speak(note.script, voice) };
}

/**
 * What the member said in a recording, each time one is sent (the same bytes again are heard,
 * and charged, again). Charged before it's heard by its size, up to the mic's two minutes, then
 * for the rest of what the provider says it heard: that time is spent, so it's charged even past
 * today's limit, which then refuses more. A recording longer than the mic makes ("long") gets
 * no words back. Under the mock there are no words: the browser asks for typed ones.
 */
export async function hearRecording(
  tenant: Tenant,
  audio: Uint8Array,
  mime: string,
): Promise<{ ok: true; text: string; mock: boolean } | { ok: false; refused: "daily" | "long" }> {
  const ref = `${sha256(audio)}:${randomUUID()}`;
  const estimate = Math.min(recordingSeconds(audio.byteLength), MAX_RECORDING_SECONDS);
  const claim = await claimVoiceClip(tenant, { kind: "transcribe", ref, seconds: estimate });
  if (!claim.ok) return claim;
  const heard = await transcribe(audio, mime);
  // In parts no bigger than one clip holds, however long the provider says it ran.
  for (let rest = heard.seconds - estimate, part = 0; rest > 0; rest -= MAX_CLIP_SECONDS, part++) {
    await claimVoiceClip(tenant, { kind: "transcribe", ref: `${ref}:rest:${part}`, seconds: Math.min(rest, MAX_CLIP_SECONDS) }, { spent: true });
  }
  if (heard.seconds > MAX_RECORDING_SECONDS + LONG_SLACK_SECONDS) return { ok: false, refused: "long" };
  return { ok: true, text: heard.text, mock: heard.mock === true };
}

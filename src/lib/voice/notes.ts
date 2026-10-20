import { callOf } from "@/lib/chat/modality";
import { MAX_VOICE_NOTE_CHARS, type ChatMessage, type RunReport, type VoiceNote } from "@/lib/types";
import { plain, speakableGist } from "./relay";

// Which replies come back as a voice note, and what it says. The member spoke, so the reply
// can be heard: a reply to their voice message says its gist (the text sits underneath), and so
// does a reply to what they said on a call that finished after they hung up (the call couldn't
// say it). A task run that brought something back says its report, written for the ear. Nothing
// else gets one: not a reply to typing, not one a call read out, and not a run that found
// nothing, failed, stopped, or waits on an approval. Only the words are decided here; the audio
// is made when the member taps play. Pure, so the worker path stays free of Next.js.

/**
 * The voice note for `final`, the reply as it's saved, or null. `answered` is the member's
 * message it answers; `report` is what a task's run reported about itself. `earlier` is what the
 * reply said before it paused for the member's decision on an approval: they've read that, so a
 * reply carried on after it is heard from where it carried on (nothing new, no note).
 * `callEnded`: the call `answered` was said on is over, so no call read this reply out.
 */
export function voiceNoteFor(
  final: ChatMessage,
  { answered, report, earlier, callEnded = false }: { answered: ChatMessage | null; report?: RunReport | null; earlier?: string | null; callEnded?: boolean },
): VoiceNote | null {
  if (final.role !== "assistant" || final.status !== "complete") return null;
  const said = since(final.content, earlier);
  const origin = answered?.origin;
  if (origin?.kind === "voice") return origin.via === "note" || callEnded ? note(speakableGist(said), "reply") : null;
  if (origin?.kind === "task") {
    if (report?.outcome !== "update" && report?.outcome !== "needs_you") return null;
    return note(plain(report.summary), "summary") ?? note(speakableGist(said), "reply");
  }
  return null;
}

/**
 * Whether the reply going now in `messages` can come back as a voice note once call `callId`
 * hangs up, by the rule above: it answers a voice message, words said on this call, or a task's
 * run (a note only if the run turns something up). A reply to typing, to words said on another
 * call, or to the setup's opening never does, so a call never offers one for it. The reply
 * answers the member's latest message, as a turn does (a retry or a decision answers it again).
 */
export function noteCanCome(messages: ChatMessage[], callId: string): boolean {
  const origin = messages.findLast((m) => m.role === "user")?.origin;
  if (origin?.kind === "task") return true;
  return origin?.kind === "voice" && (origin.via === "note" || callOf(origin) === callId);
}

/** What `content` says after `earlier`, when it carries on from it; all of it when it was rewritten. */
function since(content: string, earlier: string | null | undefined): string {
  if (!earlier?.trim() || !content.startsWith(earlier)) return content;
  return content.slice(earlier.length);
}

function note(script: string, source: VoiceNote["source"]): VoiceNote | null {
  const said = script.replace(/\s+/g, " ").trim();
  if (!said) return null;
  const chars = [...said];
  if (chars.length <= MAX_VOICE_NOTE_CHARS) return { script: said, source };
  return { script: `${chars.slice(0, MAX_VOICE_NOTE_CHARS - 1).join("").replace(/\s+\S*$/, "")}…`, source };
}

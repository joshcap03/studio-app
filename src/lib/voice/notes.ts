import { MAX_VOICE_NOTE_CHARS, type ChatMessage, type RunReport, type VoiceNote } from "@/lib/types";
import { plain, speakableGist } from "./relay";

// Which replies come back as a voice note, and what it says. The member spoke, so the reply
// can be heard: a reply to their voice message says its gist (the text sits underneath). A task
// run that brought something back says its report, written for the ear. Nothing else gets one:
// not a reply to typing, not a call (the call already said it), and not a run that found
// nothing, failed, stopped, or waits on an approval. Only the words are decided here; the audio
// is made when the member taps play. Pure, so the worker path stays free of Next.js.

/**
 * The voice note for `final`, the reply as it's saved, or null. `answered` is the member's
 * message it answers; `report` is what a task's run reported about itself. `earlier` is what the
 * reply said before it paused for the member's decision on an approval: they've read that, so a
 * reply carried on after it is heard from where it carried on (nothing new, no note).
 */
export function voiceNoteFor(
  final: ChatMessage,
  { answered, report, earlier }: { answered: ChatMessage | null; report?: RunReport | null; earlier?: string | null },
): VoiceNote | null {
  if (final.role !== "assistant" || final.status !== "complete") return null;
  const said = since(final.content, earlier);
  const origin = answered?.origin;
  if (origin?.kind === "voice") return origin.via === "note" ? note(speakableGist(said), "reply") : null;
  if (origin?.kind === "task") {
    if (report?.outcome !== "update" && report?.outcome !== "needs_you") return null;
    return note(plain(report.summary), "summary") ?? note(speakableGist(said), "reply");
  }
  return null;
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

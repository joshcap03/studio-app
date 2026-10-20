import type { MessageOrigin, Modality } from "@/lib/types";

// How the member said a message, kept on it as its origin, and how a turn that answers it
// again (a retry, an edit, a decision on an approval) is said: the same way. Pure, so the
// browser labels its own copy of a message straight away the way the server will.

/** The origin a sent message carries for how it was said: spoken on a call, or held as a voice message. */
export function originFor(modality: Modality | undefined, text: string): MessageOrigin | undefined {
  if (!text.trim()) return undefined;
  if (modality === "call") return { kind: "voice" };
  if (modality === "voice_note") return { kind: "voice", via: "note" };
  return undefined;
}

/** How a message with this origin was said; undefined when it was typed (or no one typed it). */
export function modalityOf(origin: MessageOrigin | null | undefined): Exclude<Modality, "text"> | undefined {
  if (origin?.kind !== "voice") return undefined;
  return origin.via === "note" ? "voice_note" : "call";
}

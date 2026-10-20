"use client";

import { AudioLines, Play, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { usePlayer, usePlayerProgress } from "@/components/voice/player";
import { api } from "@/lib/client/api";
import type { ChatMessage } from "@/lib/types";
import { clock } from "@/lib/voice/mic";

// A reply the member can hear: tap to play its voice note, said in the agent's voice. The text
// is always there too, underneath (the reply itself), or as the note's caption when the note
// says a task run's report rather than the reply. Nothing plays on its own: a notification
// that opens here only points at the play button (`highlight`).

/**
 * Brings the voice note on reply `messageId` into view and puts focus on its play button, so a
 * keyboard or screen reader is there too (Enter plays it; nothing plays on its own). False when
 * it isn't on the page.
 */
export function pointOutNote(messageId: string, page: Pick<Document, "getElementById"> = document): boolean {
  const button = page.getElementById(`voice-note-${messageId}`);
  if (!button) return false;
  button.scrollIntoView({ block: "center" });
  button.focus({ preventScroll: true });
  return true;
}

export function VoiceNote({ message, highlight = false }: { message: ChatMessage; highlight?: boolean }) {
  const player = usePlayer();
  const progress = usePlayerProgress();
  const note = message.voiceNote;
  const key = `note:${message.id}`;
  // Its length, once it has played: shown quietly from then on.
  const [length, setLength] = useState<number | null>(null);
  // Pointed out until it's been tapped.
  const [tapped, setTapped] = useState(false);
  const mine = progress?.key === key ? progress : null;
  useEffect(() => {
    if (mine) setLength(mine.length);
  }, [mine]);
  if (!note || !player || message.id.startsWith("pending-")) return null;

  const on = player.playing === key;
  const busy = player.loading === key;
  const failed = player.error?.key === key ? player.error : null;
  // The server's words when it said why (today's voice time is used up), else a plain miss.
  const problem = failed ? (failed.status === 429 || failed.status === 503 ? failed.message : null) ?? "Couldn't play this." : null;
  const line = problem ?? (player.held ? "You can play this after our call." : player.mock ? "Mock voice: plays a short tone, not a voice." : null);
  const shown = mine ?? (length ? { at: 0, length } : null);

  return (
    <div className="mb-3 flex flex-col items-start gap-1.5 animate-fade-in">
      <button
        type="button"
        id={`voice-note-${message.id}`}
        onClick={() => {
          setTapped(true);
          player.toggle(key, () => api.voiceNote(message.conversationId, message.id));
        }}
        disabled={player.held}
        aria-pressed={on}
        aria-label={on || busy ? "Stop the voice note" : "Play the voice note"}
        className={`relative inline-flex h-9 items-center gap-2 overflow-hidden rounded-full border bg-surface pr-3.5 pl-1.5 text-[13px] font-medium text-fg-2 transition-[background-color,border-color,box-shadow,color] duration-200 hover:bg-hover hover:text-fg disabled:opacity-50 ${
          highlight && !tapped ? "border-accent shadow-[0_0_0_3px_var(--accent-soft)]" : "border-line hover:border-line-strong"
        }`}
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-inverse text-on-inverse">
          {busy ? <span className="spinner size-3" aria-hidden="true" /> : on ? <Square size={9} fill="currentColor" /> : <Play size={10} fill="currentColor" className="ml-px" />}
        </span>
        <AudioLines size={14} className="shrink-0 text-fg-3" aria-hidden="true" />
        <span>Voice note</span>
        {shown ? (
          <span className="text-[12px] font-normal text-fg-3 tabular-nums">
            {on ? `${clock(shown.at)} / ` : ""}
            {clock(shown.length)}
          </span>
        ) : null}
        {on && mine ? (
          <span
            aria-hidden="true"
            className="absolute bottom-0 left-0 h-0.5 bg-accent transition-[width] duration-200 ease-linear"
            style={{ width: `${Math.min(100, (mine.at / mine.length) * 100)}%` }}
          />
        ) : null}
      </button>
      {note.source === "summary" ? <p className="text-[14px] leading-[1.55] text-fg-2 [overflow-wrap:anywhere]">{note.script}</p> : null}
      {line ? (
        <p role="status" className={`text-[12px] ${problem ? "text-danger" : "text-fg-3"}`}>
          {line}
        </p>
      ) : null}
    </div>
  );
}

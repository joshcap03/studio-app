"use client";

import { Check, Play, Square } from "lucide-react";
import { useMemo } from "react";
import { api } from "@/lib/client/api";
import { voiceByKey, type VoiceKey } from "@/lib/voice/voices";
import { usePlayer, VoicePlayer } from "./player";

// Hearing a voice before choosing it, wherever voices are offered (the agent's page, a proposed
// setup), on the app's one player (./player.tsx): one clip at a time, and none while a call is
// live, since the proposal card also shows on the call's stage, under the agent's own voice.
// Wherever a ▶ shows, a PreviewNote shows with it, so the mock is always labeled and a pause or
// failure always said.

interface PreviewValue {
  /** Why previews can't play right now, or null. */
  held: string | null;
  /** The mock voice: previews are a tone, not a voice. */
  mock: boolean;
  playing: VoiceKey | null;
  loading: VoiceKey | null;
  error: string | null;
  /** Where the preview that failed was asked for (a `group`), so only the note beside it says so. */
  errorFrom: string | null;
  toggle: (voice: VoiceKey, from?: string) => void;
}

const PREVIEW = "preview:";
const voiceOf = (key: string | null) => (key?.startsWith(PREVIEW) ? (key.slice(PREVIEW.length) as VoiceKey) : null);

/** Previews on this page, or null where voice is off. */
export function useVoicePreview(): PreviewValue | null {
  const player = usePlayer();
  return useMemo(() => {
    if (!player) return null;
    const failed = player.error && voiceOf(player.error.key) ? player.error : null;
    return {
      held: player.held ? "You can hear these after our call." : null,
      mock: player.mock,
      playing: voiceOf(player.playing),
      loading: voiceOf(player.loading),
      error: failed ? (failed.message ?? "Couldn't play that one. Try again.") : null,
      errorFrom: failed?.from ?? null,
      toggle: (voice: VoiceKey, from?: string) => player.toggle(`${PREVIEW}${voice}`, () => api.voicePreview(voice), from),
    };
  }, [player]);
}

/** Previews for a member with voice (and speech that can say a line); without, voices aren't offered. */
export const VoicePreviews = VoicePlayer;

/** ▶ for one voice's preview, ■ while it plays, in a `group` of voices with its own PreviewNote. Nothing where voice is off. */
export function PreviewButton({ voice, group }: { voice: VoiceKey; group?: string }) {
  const preview = useVoicePreview();
  if (!preview) return null;
  const label = voiceByKey(voice)?.label ?? voice;
  const on = preview.playing === voice;
  const busy = preview.loading === voice;
  return (
    <button
      type="button"
      onClick={() => preview.toggle(voice, group)}
      disabled={Boolean(preview.held)}
      aria-pressed={on}
      aria-label={on || busy ? `Stop the ${label} preview` : `Hear ${label}`}
      title={preview.held ?? undefined}
      className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line text-fg-2 transition-[background-color,border-color,color] duration-150 hover:border-line-strong hover:bg-hover hover:text-fg disabled:opacity-40"
    >
      {busy ? <span className="spinner size-3.5" aria-hidden="true" /> : on ? <Square size={11} fill="currentColor" /> : <Play size={12} fill="currentColor" className="ml-px" />}
    </button>
  );
}

/**
 * Why a preview won't play, what the mock plays, or what went wrong with one in its `group`;
 * nothing otherwise.
 */
export function PreviewNote({ group }: { group?: string }) {
  const preview = useVoicePreview();
  const error = preview?.error && (!preview.errorFrom || preview.errorFrom === group) ? preview.error : null;
  const text = preview && (error ?? preview.held ?? (preview.mock ? "Mock voice: previews play a short tone, not a voice." : null));
  return text ? (
    <p role="status" className={`text-[12px] ${error ? "text-danger" : "text-fg-3"}`}>
      {text}
    </p>
  ) : null;
}

/** One voice to choose: how it sounds, how it would talk (when offered with a manner), and its preview. */
export function VoiceTile({ voice, manner, chosen, onChoose, group }: { voice: VoiceKey; manner?: string; chosen: boolean; onChoose?: () => void; group?: string }) {
  const entry = voiceByKey(voice);
  return (
    <div
      className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 transition-[background-color,border-color] duration-150 ${
        chosen ? "border-accent bg-accent-soft" : onChoose ? "border-line hover:border-line-strong" : "border-line"
      }`}
    >
      <button
        type="button"
        role="radio"
        aria-checked={chosen}
        onClick={onChoose}
        disabled={!onChoose}
        className="min-w-0 flex-1 text-left disabled:cursor-default"
      >
        <span className="flex items-center gap-1.5 text-[13.5px] font-medium text-fg">
          {chosen ? <Check size={13} strokeWidth={2.5} className="settle-check text-accent" /> : null}
          {entry?.label ?? voice}
        </span>
        {entry ? <span className="mt-0.5 block text-[12.5px] leading-[1.45] text-fg-3">{entry.description}</span> : null}
        {manner ? <span className="mt-1.5 block text-[13px] leading-[1.5] text-fg-2 [overflow-wrap:anywhere]">{manner}</span> : null}
      </button>
      <PreviewButton voice={voice} group={group} />
    </div>
  );
}

"use client";

import { Check, Play, Square } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "@/lib/client/api";
import type { VoiceStatus } from "@/lib/voice/types";
import { voiceByKey, type VoiceKey } from "@/lib/voice/voices";

// Hearing a voice before choosing it, wherever voices are offered (the agent's page, a proposed
// setup). One preview plays at a time, and none while a call is live: the proposal card also
// shows on the call's stage, under the agent's own voice. The audio element is started inside
// the tap (iOS plays sound only from one) and gets the clip once it arrives, from a blob, so
// playback never depends on the server answering range requests. Wherever a ▶ shows, a
// PreviewNote shows with it, so the mock is always labeled and a pause or failure always said.

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

const Context = createContext<PreviewValue | null>(null);

/** Previews on this page, or null where voice is off. */
export function useVoicePreview(): PreviewValue | null {
  return useContext(Context);
}

let silent: string | null = null;

/** A twentieth of a second of silence (8-bit WAV), played inside the tap so the element may play the clip that follows. */
function silence(): string {
  if (silent) return silent;
  const samples = 400;
  const wav = new DataView(new ArrayBuffer(44 + samples));
  const text = (at: number, s: string) => [...s].forEach((c, i) => wav.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  wav.setUint32(4, 36 + samples, true);
  text(8, "WAVEfmt ");
  wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true);
  wav.setUint16(22, 1, true);
  wav.setUint32(24, 8000, true);
  wav.setUint32(28, 8000, true);
  wav.setUint16(32, 1, true);
  wav.setUint16(34, 8, true);
  text(36, "data");
  wav.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) wav.setUint8(44 + i, 128);
  silent = `data:audio/wav;base64,${btoa(String.fromCharCode(...new Uint8Array(wav.buffer)))}`;
  return silent;
}

/** Previews for a member with voice (and speech that can say a line); without, voices aren't offered. */
export function VoicePreviews({ voice, onCall, children }: { voice: VoiceStatus | null; onCall?: boolean; children: React.ReactNode }) {
  return voice?.speech.tts ? (
    <VoicePreviewProvider mock={!voice.live} onCall={onCall}>
      {children}
    </VoicePreviewProvider>
  ) : (
    children
  );
}

function VoicePreviewProvider({ mock, onCall = false, children }: { mock: boolean; onCall?: boolean; children: React.ReactNode }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  // Bumped on every stop, so a clip that arrives after its preview was stopped never plays.
  const turn = useRef(0);
  const [playing, setPlaying] = useState<VoiceKey | null>(null);
  const [loading, setLoading] = useState<VoiceKey | null>(null);
  const [error, setError] = useState<{ message: string; from: string | null } | null>(null);

  const stop = useCallback(() => {
    turn.current += 1;
    const el = audio.current;
    if (el) {
      el.onended = null;
      el.pause();
    }
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
    setPlaying(null);
    setLoading(null);
  }, []);

  useEffect(() => {
    if (onCall) stop();
  }, [onCall, stop]);

  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") stop();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      stop();
    };
  }, [stop]);

  const toggle = useCallback(
    (voice: VoiceKey, from?: string) => {
      if (onCall) return;
      const again = playing === voice || loading === voice;
      stop();
      setError(null);
      if (again) return;
      const mine = turn.current;
      const el = (audio.current ??= new Audio());
      el.src = silence();
      void el.play().catch(() => undefined);
      setLoading(voice);
      api
        .voicePreview(voice)
        .then(async (clip) => {
          if (turn.current !== mine) return;
          url.current = URL.createObjectURL(clip);
          el.src = url.current;
          el.onended = () => {
            if (turn.current === mine) stop();
          };
          await el.play();
          if (turn.current !== mine) return;
          setLoading(null);
          setPlaying(voice);
        })
        .catch((e: unknown) => {
          if (turn.current !== mine) return;
          stop();
          setError({ message: e instanceof ApiError ? e.message : "Couldn't play that one. Try again.", from: from ?? null });
        });
    },
    [loading, onCall, playing, stop],
  );

  const value = useMemo(
    () => ({ held: onCall ? "You can hear these after our call." : null, mock, playing, loading, error: error?.message ?? null, errorFrom: error?.from ?? null, toggle }),
    [error, loading, mock, onCall, playing, toggle],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

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

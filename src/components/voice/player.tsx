"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/client/api";
import type { VoiceStatus } from "@/lib/voice/types";

// Every clip of speech the app plays outside a call: a voice's preview (where voices are offered)
// and a reply's voice note. One plays at a time, and none while a call is live (the call has the
// agent's own voice) or while the tab is hidden; typing a message or opening the mic stops it too
// (stop). The audio element is started inside the tap (iOS plays sound only from one) and gets
// the clip once it arrives, from a blob, so playback never depends on the server answering range
// requests. Whether a call is live is shared too (useCallLive), with or without speech: the
// message box's mic gives way to the call's.

/** What went wrong with the clip named `key`, asked for from `from` (a group of buttons). */
export interface PlayerError {
  key: string;
  from: string | null;
  status: number | null;
  /** The server's own words, when it said why. */
  message: string | null;
}

export interface PlayerState {
  /** A call is live, so nothing plays. */
  held: boolean;
  /** The mock voice: clips are a tone, not a voice. */
  mock: boolean;
  /** The clip playing, and the one on its way, by key ("preview:<voice>", "note:<message id>"). */
  playing: string | null;
  loading: string | null;
  error: PlayerError | null;
}

export interface PlayerControls {
  /** Plays the clip named `key`, fetched by `load` (call it from the tap), or stops it when it's this one. */
  toggle: (key: string, load: () => Promise<Blob>, from?: string) => void;
  stop: () => void;
}

/** How far the playing clip has got, in seconds, once its length is known. */
export interface PlayerProgress {
  key: string;
  at: number;
  length: number;
}

const State = createContext<PlayerState | null>(null);
const Controls = createContext<PlayerControls | null>(null);
const Progress = createContext<PlayerProgress | null>(null);
const CallLive = createContext(false);

/** Whether a voice call is live, so nothing else may use the speaker or the mic. */
export function useCallLive(): boolean {
  return useContext(CallLive);
}

/** What's playing, or null where voice is off. */
export function usePlayer(): (PlayerState & PlayerControls) | null {
  const state = useContext(State);
  const controls = useContext(Controls);
  return useMemo(() => (state && controls ? { ...state, ...controls } : null), [state, controls]);
}

/** Just the controls, which never change: for stopping playback without following it. */
export function usePlayerControls(): PlayerControls | null {
  return useContext(Controls);
}

export function usePlayerProgress(): PlayerProgress | null {
  return useContext(Progress);
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

/** The player for a member with voice (and speech that can say a line); without, nothing plays. */
export function VoicePlayer({ voice, onCall = false, children }: { voice: VoiceStatus | null; onCall?: boolean; children: React.ReactNode }) {
  return (
    <CallLive.Provider value={onCall}>
      {voice?.speech.tts ? (
        <PlayerProvider mock={!voice.live} onCall={onCall}>
          {children}
        </PlayerProvider>
      ) : (
        children
      )}
    </CallLive.Provider>
  );
}

function PlayerProvider({ mock, onCall = false, children }: { mock: boolean; onCall?: boolean; children: React.ReactNode }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  // Bumped on every stop, so a clip that arrives after it was stopped never plays.
  const turn = useRef(0);
  /** The clip loading or playing now, for telling a second tap on it from a tap on another. */
  const current = useRef<string | null>(null);
  const held = useRef(onCall);
  held.current = onCall;
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<PlayerError | null>(null);
  const [progress, setProgress] = useState<PlayerProgress | null>(null);

  const stop = useCallback(() => {
    turn.current += 1;
    current.current = null;
    const el = audio.current;
    if (el) {
      el.onended = null;
      el.ontimeupdate = null;
      el.pause();
    }
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
    setPlaying(null);
    setLoading(null);
    setProgress(null);
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
    (key: string, load: () => Promise<Blob>, from?: string) => {
      if (held.current) return;
      const again = current.current === key;
      stop();
      setError(null);
      if (again) return;
      const mine = turn.current;
      current.current = key;
      const el = (audio.current ??= new Audio());
      el.src = silence();
      void el.play().catch(() => undefined);
      setLoading(key);
      load()
        .then(async (clip) => {
          if (turn.current !== mine) return;
          url.current = URL.createObjectURL(clip);
          el.src = url.current;
          el.onended = () => {
            if (turn.current === mine) stop();
          };
          el.ontimeupdate = () => {
            if (turn.current === mine && Number.isFinite(el.duration) && el.duration > 0) setProgress({ key, at: el.currentTime, length: el.duration });
          };
          await el.play();
          if (turn.current !== mine) return;
          setLoading(null);
          setPlaying(key);
        })
        .catch((e: unknown) => {
          if (turn.current !== mine) return;
          stop();
          setError({ key, from: from ?? null, status: e instanceof ApiError ? e.status : null, message: e instanceof ApiError ? e.message : null });
        });
    },
    [stop],
  );

  const controls = useMemo(() => ({ toggle, stop }), [toggle, stop]);
  const state = useMemo(() => ({ held: onCall, mock, playing, loading, error }), [error, loading, mock, onCall, playing]);
  return (
    <Controls.Provider value={controls}>
      <State.Provider value={state}>
        <Progress.Provider value={progress}>{children}</Progress.Provider>
      </State.Provider>
    </Controls.Provider>
  );
}

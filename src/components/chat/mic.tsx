"use client";

import { Mic, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Tooltip } from "radix-ui";
import { TooltipContent } from "@/components/ui/icon-button";
import { useCallLive, usePlayerControls } from "@/components/voice/player";
import { ApiError, api } from "@/lib/client/api";
import {
  clock,
  listening,
  MAX_RECORDING_BYTES,
  MAX_RECORDING_SECONDS,
  MIC_IDLE,
  micProblem,
  micReducer,
  NOTHING_CAUGHT,
  pressMode,
  recordingType,
  type MicEvent,
  type MicMode,
  type MicState,
} from "@/lib/voice/mic";

// The message box's mic (src/lib/voice/mic.ts has the rules): hold to send a voice message, tap
// to dictate into the draft. The recording goes to the server once, to be turned into words, and
// isn't kept anywhere. Under the mock voice nothing is recorded: the mic opens a labeled box to
// type what you'd say instead, so the whole path can be tried without a provider. While a call is
// live the mic is the call's: this one stops, and waits until it ends.

/** Sliding this far off the mic while holding it calls the message off. */
const SLIDE_AWAY_PX = 56;

export interface MicControl {
  state: MicState;
  /** A call is live, so this mic waits. */
  held: boolean;
  /** Seconds recorded so far. */
  elapsed: number;
  /** The mock's typed stand-in, open in this mode. */
  typing: MicMode | null;
  closeTyping: () => void;
  /** Words typed into the mock's stand-in. */
  typed: (words: string) => void;
  cancel: () => void;
  dismiss: () => void;
  button: {
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => void;
    onPointerCancel: () => void;
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
    onContextMenu: (e: React.MouseEvent) => void;
  };
}

/**
 * The mic's state and handlers. `onWords` gets what the member said and how (held as a voice
 * message, or dictated); the composer decides where it goes. Null where the browser can't record.
 */
export function useMic({ mock, onWords }: { mock: boolean; onWords: (words: string, mode: MicMode) => void }): MicControl | null {
  const player = usePlayerControls();
  const onCall = useCallLive();
  const held = useRef(onCall);
  held.current = onCall;
  const [state, setState] = useState<MicState>(MIC_IDLE);
  const current = useRef<MicState>(MIC_IDLE);
  const [elapsed, setElapsed] = useState(0);
  const [typing, setTyping] = useState<MicMode | null>(null);
  const [supported, setSupported] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  // Bumped whenever a recording is dropped, so its late callbacks change nothing.
  const session = useRef(0);
  const press = useRef<{ x: number; y: number; at: number } | null>(null);
  const words = useRef(onWords);
  words.current = onWords;

  // Decided after hydration: recording needs a browser that has it (and a page served securely).
  useEffect(() => {
    setSupported(mock || (typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia)));
  }, [mock]);

  const releaseDevice = useCallback(() => {
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
    recorder.current = null;
  }, []);

  /** Drops the recording under way, if any. */
  const discard = useCallback(() => {
    session.current += 1;
    const rec = recorder.current;
    if (rec) {
      rec.ondataavailable = null;
      rec.onstop = null;
      if (rec.state !== "inactive") rec.stop();
    }
    chunks.current = [];
    releaseDevice();
  }, [releaseDevice]);

  // Each event moves the mic along (micReducer), and the move says what to do with the device:
  // open it, drop what it recorded, or hand the recording over to be heard.
  const send = useCallback(
    (event: MicEvent) => {
      const prev = current.current;
      const next = micReducer(prev, event);
      if (next === prev) return;
      current.current = next;
      setState(next);
      if (next.phase === "starting" && !listening(prev)) open();
      else if (listening(prev) && !listening(next) && next.phase !== "hearing") discard();
      if (next.phase === "hearing" && prev.phase !== "hearing") finish(next.mode);
    },
    [discard], // open and finish only touch refs and send itself.
  );

  function open() {
    const mine = ++session.current;
    player?.stop();
    setElapsed(0);
    void (async () => {
      try {
        const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (session.current !== mine) {
          for (const track of media.getTracks()) track.stop();
          return;
        }
        const type = recordingType((t) => MediaRecorder.isTypeSupported(t));
        // Speech needs little: 32 kbit/s keeps two minutes well under the server's limit.
        const rec = new MediaRecorder(media, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 32_000 });
        chunks.current = [];
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.current.push(e.data);
        };
        // The browser stopped it (the device went, the phone locked): what was said goes into the draft.
        rec.onstop = () => {
          if (session.current === mine) send({ type: "hide" });
        };
        stream.current = media;
        recorder.current = rec;
        rec.start(1000);
        send({ type: "started", at: Date.now() });
      } catch (e) {
        if (session.current !== mine) return;
        const err = e as { name?: string; message?: string };
        send({ type: "failed", message: micProblem(`${err.name ?? ""}: ${err.message ?? ""}`, "tap the mic again") ?? "The mic didn't start. Try again, or type instead." });
      }
    })();
  }

  function finish(mode: MicMode) {
    const rec = recorder.current;
    const mine = session.current;
    const deliver = () => {
      const recording = new Blob(chunks.current, { type: rec?.mimeType || "audio/webm" });
      chunks.current = [];
      releaseDevice();
      if (session.current !== mine) return;
      if (recording.size === 0) return send({ type: "failed", message: NOTHING_CAUGHT });
      if (recording.size > MAX_RECORDING_BYTES) return send({ type: "failed", message: "That recording is too long. Keep it under two minutes." });
      api.transcribe(recording).then(
        ({ text }) => {
          if (session.current !== mine) return;
          if (!text.trim()) return send({ type: "failed", message: "Didn't catch any words. Try again." });
          send({ type: "heard" });
          words.current(text, mode);
        },
        (error: unknown) => {
          if (session.current !== mine) return;
          send({ type: "failed", message: error instanceof ApiError ? error.message : "Couldn't hear that. Try again, or type it." });
        },
      );
    };
    if (rec && rec.state !== "inactive") {
      rec.onstop = deliver;
      rec.stop();
    } else {
      deliver();
    }
  }

  // The timer, and the two-minute limit.
  const recording = state.phase === "recording";
  const startedAt = recording ? state.startedAt : 0;
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      const at = Date.now();
      setElapsed((at - startedAt) / 1000);
      send({ type: "tick", at });
    }, 250);
    return () => clearInterval(timer);
  }, [recording, startedAt, send]);

  // Esc drops it; hiding the page (a locked phone stops the mic) keeps what was said, in the draft.
  const on = listening(state);
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      send({ type: "cancel" });
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") send({ type: "hide" });
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [on, send]);

  // A call takes the mic (one started from the setup banner leaves this box mounted under it).
  useEffect(() => {
    if (!onCall) return;
    send({ type: "call" });
    setTyping(null);
  }, [onCall, send]);

  useEffect(() => () => discard(), [discard]);

  if (!supported) return null;
  return {
    state,
    held: onCall,
    elapsed,
    typing,
    closeTyping: () => setTyping(null),
    typed: (said: string) => {
      const mode = typing;
      setTyping(null);
      if (mode && said.trim()) words.current(said, mode);
    },
    cancel: () => send({ type: "cancel" }),
    dismiss: () => send({ type: "dismiss" }),
    button: {
      onPointerDown: (e) => {
        if (e.button !== 0 || held.current) return;
        // Keeps the caret in the draft (the mic never takes focus from a press), and the press
        // from becoming a text selection or a long-press menu.
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // A pointer the browser no longer tracks: the press still counts.
        }
        press.current = { x: e.clientX, y: e.clientY, at: Date.now() };
        if (mock) {
          player?.stop();
          return;
        }
        send({ type: "press", at: Date.now() });
      },
      onPointerMove: (e) => {
        const from = press.current;
        if (!from || mock) return;
        const s = current.current;
        if (!listening(s) || !s.down) return;
        if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > SLIDE_AWAY_PX) {
          press.current = null;
          send({ type: "cancel" });
        }
      },
      onPointerUp: () => {
        const from = press.current;
        press.current = null;
        if (held.current) return;
        if (mock) {
          if (from) setTyping(pressMode(from.at, Date.now()));
          return;
        }
        send({ type: "release", at: Date.now() });
      },
      onPointerCancel: () => {
        press.current = null;
        if (!mock) send({ type: "interrupt" });
      },
      // The keyboard (Enter, Space) and assistive taps arrive as a click with no pointer press.
      onClick: (e) => {
        if (e.detail !== 0 || held.current) return;
        if (mock) setTyping((t) => (t ? null : "dictation"));
        else send({ type: "toggle", at: Date.now() });
      },
      onContextMenu: (e) => e.preventDefault(),
    },
  };
}

/** The mic, beside Send. */
export function MicButton({ mic }: { mic: MicControl }) {
  const { state } = mic;
  const on = listening(state);
  const dictating = on && state.mode === "dictation";
  const label = dictating ? "Stop dictating" : on ? "Recording a voice message" : "Voice: hold to send a voice message, or tap to dictate";
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          {...mic.button}
          disabled={state.phase === "hearing" || mic.held}
          aria-label={label}
          aria-pressed={on || mic.typing !== null}
          className={`flex size-8 shrink-0 touch-none items-center justify-center rounded-full transition-[background-color,color,transform] duration-150 select-none [-webkit-touch-callout:none] active:scale-90 disabled:opacity-50 ${
            on ? "bg-danger-soft text-danger" : "text-fg-3 hover:bg-hover hover:text-fg"
          }`}
        >
          {state.phase === "hearing" ? <span className="spinner size-3.5" aria-hidden="true" /> : <Mic size={17} strokeWidth={1.75} />}
        </button>
      </Tooltip.Trigger>
      <TooltipContent label={on ? (dictating ? "Tap to stop" : "Release to send") : "Hold to send a voice message, or tap to dictate"} side="top" />
    </Tooltip.Root>
  );
}

/** What the mic is doing, above the draft; the mock's typed stand-in; or why it couldn't. Nothing while it's off. */
export function MicStatus({ mic, holdsToDraft }: { mic: MicControl; holdsToDraft: boolean }) {
  const { state } = mic;
  if (mic.typing) return <MockSpeech mode={mic.typing} holdsToDraft={holdsToDraft} onSay={mic.typed} onClose={mic.closeTyping} />;
  if (state.phase === "idle") return null;
  const row = "flex min-h-7 basis-full items-center gap-2 text-[13px] animate-fade-in";
  if (state.phase === "problem") {
    return (
      <div role="alert" className={`${row} text-danger`}>
        <span className="min-w-0 flex-1">{state.message}</span>
        <button type="button" onClick={mic.dismiss} aria-label="Dismiss" className="flex size-6 shrink-0 items-center justify-center rounded-full text-fg-3 hover:bg-hover hover:text-fg">
          <X size={13} />
        </button>
      </div>
    );
  }
  if (state.phase === "hearing") {
    return (
      <div role="status" className={`${row} text-fg-3`}>
        <span className="spinner size-3.5" aria-hidden="true" />
        Getting your words…
      </div>
    );
  }
  const held = state.down && state.mode === null;
  const hint =
    state.phase === "starting"
      ? "Opening the mic…"
      : held
        ? holdsToDraft
          ? "Let go to add it to your message · slide away to cancel"
          : "Let go to send · slide away to cancel"
        : "Listening · tap the mic to stop · Esc cancels";
  // Only the hint is announced (it changes with what the mic is doing); the timer, ticking every
  // second, stays out of the announcement, to be read when the member looks for it.
  return (
    <div className={`${row} text-fg-2`}>
      <span className={`size-2 shrink-0 rounded-full ${state.phase === "recording" ? "bg-danger breathe-soft" : "bg-fg-4"}`} aria-hidden="true" />
      {state.phase === "recording" ? (
        <span className="text-fg-3 tabular-nums">
          {clock(mic.elapsed)} / {clock(MAX_RECORDING_SECONDS)}
        </span>
      ) : null}
      <span role="status" className="min-w-0 flex-1 truncate">
        {hint}
      </span>
      {!held ? (
        <button type="button" onClick={mic.cancel} aria-label="Cancel" className="flex size-6 shrink-0 items-center justify-center rounded-full text-fg-3 hover:bg-hover hover:text-fg">
          <X size={13} />
        </button>
      ) : null}
    </div>
  );
}

/** MOCK VOICE: what the member would say, typed, standing in for a recording (no audio, no provider). */
function MockSpeech({ mode, holdsToDraft, onSay, onClose }: { mode: MicMode; holdsToDraft: boolean; onSay: (words: string) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const sends = mode === "message" && !holdsToDraft;
  return (
    <div className="flex basis-full flex-col gap-1.5 rounded-xl border border-dashed border-line-strong bg-subtle px-3 py-2 animate-fade-in">
      <p className="text-[12px] text-fg-3">
        Mock voice: type what you&apos;d say. {sends ? "It goes as a voice message." : "It goes into your message."}
      </p>
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (text.trim()) onSay(text);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
          aria-label="Mock voice: what you'd say"
          className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 text-[14px] text-fg outline-none focus:border-line-strong max-md:text-[16px]"
        />
        <button
          type="button"
          onClick={() => text.trim() && onSay(text)}
          disabled={!text.trim()}
          className="inline-flex h-8 shrink-0 items-center rounded-lg bg-inverse px-3 text-[13px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:bg-press disabled:text-fg-4"
        >
          {sends ? "Send" : "Add"}
        </button>
        <button type="button" onClick={onClose} aria-label="Close" className="flex size-8 shrink-0 items-center justify-center rounded-full text-fg-3 hover:bg-hover hover:text-fg">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

"use client";

import { MousePointerClick } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useBrowserFrames } from "@/components/voice/browser-view";
import { api, ApiError } from "@/lib/client/api";
import type { DriveInput } from "@/lib/browser-fill";
import { DRIVE_KEYS, type DriveKey, type ShownStep } from "@/lib/types";

// Driving the agent's browser from a card: a live picture of the page, where a click or scroll on
// the picture happens on the page, and what's typed in the box below is typed there. The browser's
// connection stays on the server (src/app/api/conversations/[id]/browser/input). Shared by the
// secure card's "Do it myself" and "Show me once", which records: each input comes back as the
// step the server saw it was (`onStep`), never with what went into a password, card, or code field.
// The keyboard works as on the page itself: after a click on the picture, keys go straight there
// (letters gathered into one bit of typing), and in the box Enter, Tab, and (when it's empty)
// Backspace and the arrows pass through too.

/** Letters typed on the picture go together once they pause this long. */
const TYPING_PAUSE_MS = 400;
/** The most the input route takes in one go. */
const MAX_TEXT = 500;

const isDriveKey = (key: string): key is DriveKey => (DRIVE_KEYS as readonly string[]).includes(key);

type Keystroke = Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey" | "isComposing">;

/**
 * What a keystroke does on the page: a key pressed there, letters typed there, or nothing (a
 * shortcut, Shift+Tab, mid-composition). In the box (`box` is what's in it), letters are the box's
 * own, and so are Backspace, Escape, and the arrows while it has something in it.
 */
export function keystroke(e: Keystroke, box?: string): { press: DriveKey } | { type: string } | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return null;
  if (isDriveKey(e.key)) {
    if (e.key === "Tab" && e.shiftKey) return null;
    if (box && e.key !== "Enter" && e.key !== "Tab") return null;
    return { press: e.key };
  }
  return box === undefined && [...e.key].length === 1 ? { type: e.key } : null;
}

const input =
  "w-full rounded-lg border border-line bg-transparent px-3 py-2 text-[14px] leading-[1.5] text-fg placeholder:text-fg-4 focus:border-line-strong focus:outline-none";
const secondary = "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg disabled:opacity-60";

export function BrowserDrive({
  conversationId,
  onStep,
  queue: shared,
  status = "You're driving. The agent waits.",
}: {
  conversationId: string;
  /** Recording: each input's step, as the server saw it. */
  onStep?: (step: ShownStep) => void;
  /** The inputs in flight, in order, for a card that has to wait for the last one to land. */
  queue?: React.RefObject<Promise<unknown>>;
  status?: string;
}) {
  const frames = useBrowserFrames(conversationId, true, 700);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const record = Boolean(onStep);
  const stepRef = useRef(onStep);
  stepRef.current = onStep;

  // One at a time, in order: a click has to land before the typing meant for the field it picks.
  const own = useRef<Promise<unknown>>(Promise.resolve());
  const queue = shared ?? own;
  const drive = (input: DriveInput) => {
    // A step is when they did it, on this device's clock, so notes they add meanwhile fall after it.
    const sent = Date.now();
    return (queue.current = queue.current.then(() =>
      api.driveBrowser(conversationId, input, { record }).then(
        (done) => {
          setError(null);
          if (done.step) stepRef.current?.({ ...done.step, at: sent });
        },
        (e: unknown) => setError(e instanceof ApiError ? e.message : "Couldn't reach the browser just now."),
      ),
    ));
  };
  // Typing on the picture: letters wait here until a pause or the next click, key, or scroll.
  const pending = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = () => {
    clearTimeout(timer.current);
    const typed = pending.current;
    pending.current = "";
    if (typed) void drive({ type: "text", text: typed });
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);
  const gather = (typed: string) => {
    for (const ch of typed) {
      pending.current += ch;
      if (pending.current.length >= MAX_TEXT) flush();
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, TYPING_PAUSE_MS);
  };
  const press = (key: DriveKey) => {
    flush();
    void drive({ type: "key", key });
  };
  const typeBox = () => {
    if (!text) return;
    const typed = text;
    setText("");
    void drive({ type: "text", text: typed });
  };

  const at = (e: React.MouseEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)) };
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div
        tabIndex={frames.kind === "showing" ? 0 : undefined}
        role={frames.kind === "showing" ? "application" : undefined}
        aria-label={frames.kind === "showing" ? "The agent's browser. Click to click there, then type to type there." : undefined}
        className="overflow-hidden rounded-lg border border-line bg-subtle focus:border-line-strong focus:outline-none"
        onKeyDown={(e) => {
          const does = frames.kind === "showing" ? keystroke(e.nativeEvent) : null;
          if (!does) return;
          e.preventDefault();
          if ("press" in does) press(does.press);
          else gather(does.type);
        }}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData("text/plain");
          if (frames.kind !== "showing" || !pasted) return;
          e.preventDefault();
          gather(pasted);
        }}
        onBlur={flush}
      >
        {frames.kind === "showing" ? (
          // eslint-disable-next-line @next/next/no-img-element -- a live picture from our own route, not a static asset
          <img
            src={frames.url}
            alt=""
            draggable={false}
            className="block w-full cursor-pointer select-none"
            onClick={(e) => {
              e.currentTarget.parentElement?.focus({ preventScroll: true });
              flush();
              void drive({ type: "click", ...at(e) });
            }}
            onWheel={(e) => {
              flush();
              void drive({ type: "scroll", ...at(e), dy: Math.max(-2000, Math.min(2000, e.deltaY)) });
            }}
          />
        ) : (
          <p className="px-3 py-6 text-center text-[13px] text-fg-3">{frames.kind === "gone" ? "The browser has closed." : "Opening the browser…"}</p>
        )}
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          typeBox();
        }}
      >
        <input
          type="password"
          value={text}
          maxLength={MAX_TEXT}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            const does = keystroke(e.nativeEvent, text);
            if (!does || !("press" in does)) return;
            e.preventDefault();
            typeBox();
            press(does.press);
          }}
          placeholder="Click a field above, then type"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          aria-label="Type into the page"
          className={input}
        />
        <button type="submit" disabled={!text} className={secondary}>
          Type
        </button>
      </form>
      <div className="flex flex-wrap items-center gap-1.5">
        {(["Tab", "Enter", "Backspace"] as const).map((key) => (
          <button key={key} type="button" onClick={() => press(key)} className="inline-flex h-7 items-center rounded-md border border-line px-2 text-[12px] text-fg-2 hover:bg-hover hover:text-fg">
            {key}
          </button>
        ))}
        <span className={`ml-auto flex items-center gap-1.5 text-[12px] ${error ? "text-danger" : "text-fg-3"}`}>
          {error ? null : <MousePointerClick size={12} aria-hidden="true" />}
          {error ?? status}
        </span>
      </div>
    </div>
  );
}

"use client";

import { MousePointerClick } from "lucide-react";
import { useRef, useState } from "react";
import { useBrowserFrames } from "@/components/voice/browser-view";
import { api, ApiError } from "@/lib/client/api";
import type { DriveInput } from "@/lib/browser-fill";
import type { ShownStep } from "@/lib/types";

// Driving the agent's browser from a card: a live picture of the page, where a click or scroll on
// the picture happens on the page, and what's typed in the box below is typed there. The browser's
// connection stays on the server (src/app/api/conversations/[id]/browser/input). Shared by the
// secure card's "Do it myself" and "Show me once", which records: each input comes back as the
// step the server saw it was (`onStep`), never with what went into a password, card, or code field.

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
  const at = (e: React.MouseEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)) };
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="overflow-hidden rounded-lg border border-line bg-subtle">
        {frames.kind === "showing" ? (
          // eslint-disable-next-line @next/next/no-img-element -- a live picture from our own route, not a static asset
          <img
            src={frames.url}
            alt="The agent's browser. Click to click there."
            draggable={false}
            className="block w-full cursor-pointer select-none"
            onClick={(e) => void drive({ type: "click", ...at(e) })}
            onWheel={(e) => void drive({ type: "scroll", ...at(e), dy: Math.max(-2000, Math.min(2000, e.deltaY)) })}
          />
        ) : (
          <p className="px-3 py-6 text-center text-[13px] text-fg-3">{frames.kind === "gone" ? "The browser has closed." : "Opening the browser…"}</p>
        )}
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text) return;
          const typed = text;
          setText("");
          void drive({ type: "text", text: typed });
        }}
      >
        <input
          type="password"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Click a field above, then type here"
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
          <button key={key} type="button" onClick={() => void drive({ type: "key", key })} className="inline-flex h-7 items-center rounded-md border border-line px-2 text-[12px] text-fg-2 hover:bg-hover hover:text-fg">
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

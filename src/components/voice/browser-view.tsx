"use client";

import { useEffect, useRef, useState } from "react";

// What the agent's browser shows, for watching it on a call: a picture the server takes every
// couple of seconds (src/lib/browser-view.ts), view only. Nothing here can drive the browser:
// it's an image, and the browser's connection never leaves the server. It looks only while the
// page is visible and stops once the browser has closed or isn't there.

const EVERY_MS = 2000;

export type BrowserFrames = { kind: "waiting" } | { kind: "showing"; url: string; at: number } | { kind: "gone" };

/** Pictures of the conversation's browser, every `everyMs` while `active` and the page is visible. */
export function useBrowserFrames(conversationId: string, active: boolean, everyMs = EVERY_MS): BrowserFrames {
  const [state, setState] = useState<BrowserFrames>({ kind: "waiting" });
  const url = useRef<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const look = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") {
        try {
          const res = await fetch(`/api/conversations/${conversationId}/browser`, { cache: "no-store" });
          if (res.status === 404) {
            setState((s) => (s.kind === "showing" ? { kind: "gone" } : s));
            if (stopped) return;
          } else if (res.ok) {
            const next = URL.createObjectURL(await res.blob());
            if (stopped) return URL.revokeObjectURL(next);
            if (url.current) URL.revokeObjectURL(url.current);
            url.current = next;
            setState({ kind: "showing", url: next, at: Date.now() });
          }
        } catch {
          // a missed picture; the next one may come
        }
      }
      timer = setTimeout(() => void look(), everyMs);
    };
    void look();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, conversationId, everyMs]);

  useEffect(
    () => () => {
      if (url.current) URL.revokeObjectURL(url.current);
    },
    [],
  );
  return state;
}

/** Pictures of the conversation's browser while `active`; nothing at all until there's one to show. */
export function BrowserView({ conversationId, active }: { conversationId: string; active: boolean }) {
  const state = useBrowserFrames(conversationId, active);

  if (state.kind === "waiting") return null;
  return (
    <figure className="mt-4 overflow-hidden rounded-xl border border-line bg-surface animate-fade-in">
      {state.kind === "showing" ? (
        // eslint-disable-next-line @next/next/no-img-element -- a live picture from our own route, not a static asset
        <img src={state.url} alt="What my browser shows right now" draggable={false} className="block w-full select-none" />
      ) : null}
      <figcaption className="flex items-center gap-1.5 px-3 py-2 text-[12px] text-fg-3">
        <span className={`size-1.5 rounded-full ${state.kind === "showing" ? "bg-accent" : "bg-fg-4"}`} aria-hidden="true" />
        {state.kind === "showing" ? "My browser · view only" : "My browser has closed."}
      </figcaption>
    </figure>
  );
}

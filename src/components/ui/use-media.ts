"use client";

import { useSyncExternalStore } from "react";

/** Subscribe to a CSS media query. Returns `fallback` during server rendering. */
export function useMedia(query: string, fallback = false): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => fallback,
  );
}

export const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * The visible height while an on-screen keyboard covers part of the page, else null. iOS
 * keeps the layout viewport (and `100dvh`) full height under the keyboard, so a full-height
 * shell can be dragged up by the keyboard's height; sizing it to this keeps it pinned.
 */
export function useKeyboardHeight(): number | null {
  return useSyncExternalStore(
    (onChange) => {
      const vv = window.visualViewport;
      if (!vv) return () => {};
      const update = () => {
        // The browser pans the page to show the caret; the shell already fits, so undo it.
        if (covered(vv) !== null && window.scrollY !== 0) window.scrollTo(0, 0);
        onChange();
      };
      vv.addEventListener("resize", update);
      vv.addEventListener("scroll", update);
      return () => {
        vv.removeEventListener("resize", update);
        vv.removeEventListener("scroll", update);
      };
    },
    () => (window.visualViewport ? covered(window.visualViewport) : null),
    () => null,
  );
}

function covered(vv: VisualViewport): number | null {
  // Pinch-zoom also shrinks the visual viewport; that isn't a keyboard.
  if (vv.scale > 1.01) return null;
  const visible = Math.round(vv.height);
  return visible < document.documentElement.clientHeight - 1 ? visible : null;
}

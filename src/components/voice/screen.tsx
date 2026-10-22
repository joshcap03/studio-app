"use client";

import { createContext, useContext, useEffect, useRef } from "react";
import type { ScreenAction } from "@/lib/voice/types";

// The buttons on the page the member is on that a call can press when they name one ("pause
// it"). The page registers the same handlers its own buttons call; the workspace keeps the
// latest set and hands the call their names. Each resolves true when it took effect.

export type ScreenButtons = Partial<Record<ScreenAction, () => Promise<boolean> | boolean>>;

export const ScreenButtonsContext = createContext<((buttons: ScreenButtons | null) => void) | null>(null);

/** Registers this page's buttons while it's on screen, by name; their handlers stay current. */
export function useScreenButtons(buttons: ScreenButtons) {
  const register = useContext(ScreenButtonsContext);
  const latest = useRef(buttons);
  latest.current = buttons;
  const names = Object.keys(buttons).sort().join(",");
  useEffect(() => {
    if (!register) return;
    const listed = (names ? names.split(",") : []) as ScreenAction[];
    register(Object.fromEntries(listed.map((name) => [name, () => latest.current[name]?.() ?? false])));
    return () => register(null);
  }, [register, names]);
}

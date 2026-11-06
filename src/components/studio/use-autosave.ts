"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Saves what's being edited a moment after typing stops, on blur, on Cmd+S, and on leaving. Each save
// waits for the one before it, so the latest words always land last.

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export function useAutosave<T>(value: T, save: (value: T) => Promise<void>, { valid = true, delay = 700 }: { valid?: boolean; delay?: number } = {}) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const latest = useRef({ value, save, valid });
  latest.current = { value, save, valid };
  const saved = useRef(JSON.stringify(value));
  const chain = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const { value: now, save: run, valid: ok } = latest.current;
    const text = JSON.stringify(now);
    if (!ok || text === saved.current) return;
    saved.current = text;
    setStatus("saving");
    setError(null);
    chain.current = chain.current.then(() =>
      run(now).then(
        () => setStatus((s) => (s === "error" ? s : "saved")),
        (e: unknown) => {
          // Left unsaved, so the next edit or Cmd+S tries again.
          saved.current = "";
          setStatus("error");
          setError(e instanceof Error ? e.message : "Couldn't save. Try again.");
        },
      ),
    );
  }, []);

  useEffect(() => {
    if (JSON.stringify(value) === saved.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, delay, flush]);

  // Leaving with words unsaved.
  useEffect(() => flush, [flush]);

  return { status, error, flush };
}

export function saveLine(status: SaveStatus, error: string | null): string {
  if (status === "saving") return "Saving…";
  if (status === "saved") return "Saved. Live on the next reply.";
  if (status === "error") return error ?? "Couldn't save. Try again.";
  return "";
}

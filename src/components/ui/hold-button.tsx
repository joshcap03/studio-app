"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// A button that acts only once it's pressed and held: it fills while held, gives a light tick
// on devices that can, and drains if let go early. A quick tap says to hold instead. Keyboard
// holds Enter or Space the same way; assistive tech that activates without a press acts at once.

const HOLD_MS = 650;
const NUDGE_MS = 1600;

export function HoldButton({
  onHold,
  disabled,
  label,
  nudge,
  icon,
  className = "",
}: {
  onHold: () => void;
  disabled?: boolean;
  label: string;
  /** Said for a moment after a tap too quick to count, like "Hold to approve". */
  nudge: string;
  icon?: ReactNode;
  className?: string;
}) {
  const [holding, setHolding] = useState(false);
  const [nudging, setNudging] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pressed = useRef(false);
  const startedAt = useRef(0);
  // The hold ends after a re-render or two: it acts with the latest handler, not the one it began with.
  const latest = useRef(onHold);
  useEffect(() => {
    latest.current = onHold;
  });

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      clearTimeout(nudgeTimer.current);
    },
    [],
  );

  function start(byKey = false) {
    if (disabled || timer.current) return;
    if (!byKey) pressed.current = true;
    startedAt.current = Date.now();
    setNudging(false);
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setHolding(false);
      navigator.vibrate?.(12);
      latest.current();
    }, HOLD_MS);
  }

  function stop() {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = undefined;
    setHolding(false);
    if (Date.now() - startedAt.current < HOLD_MS * 0.6) {
      setNudging(true);
      clearTimeout(nudgeTimer.current);
      nudgeTimer.current = setTimeout(() => setNudging(false), NUDGE_MS);
    }
  }

  const isKey = (key: string) => key === "Enter" || key === " ";

  return (
    <button
      type="button"
      disabled={disabled}
      aria-description="Press and hold"
      onPointerDown={(e) => {
        if (e.button === 0) start();
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (!isKey(e.key)) return;
        e.preventDefault();
        if (!e.repeat) start(true);
      }}
      onKeyUp={(e) => {
        if (!isKey(e.key)) return;
        e.preventDefault();
        stop();
      }}
      onClick={() => {
        // A press already ran through the hold; a click with no press is assistive tech.
        if (pressed.current) pressed.current = false;
        else if (!disabled) onHold();
      }}
      className={`relative isolate overflow-hidden select-none [-webkit-touch-callout:none] ${holding ? "scale-[0.98]" : ""} transition-transform duration-150 ${className}`}
    >
      <span
        aria-hidden="true"
        className="absolute inset-0 -z-10 origin-left bg-on-inverse/20"
        style={{
          transform: `scaleX(${holding ? 1 : 0})`,
          transition: holding ? `transform ${HOLD_MS}ms linear` : "transform 200ms var(--ease-out-soft)",
        }}
      />
      {icon}
      <span key={nudging ? "nudge" : "label"} className={nudging ? "animate-fade-in" : undefined}>
        {nudging ? nudge : label}
      </span>
    </button>
  );
}

"use client";

/** A switch, in Studio's tokens: brass when on. */
export function OnHomeSwitch({ on, busy, onToggle, label }: { on: boolean; busy?: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={busy}
      onClick={onToggle}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-60 ${on ? "bg-accent" : "bg-line-strong"}`}
    >
      <span aria-hidden="true" className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-surface shadow-sm transition-transform ${on ? "translate-x-4" : ""}`} />
    </button>
  );
}

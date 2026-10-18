// The call's orb. Each state means something real: who has the floor, whether the member's words
// reached the worker, whether real progress is coming in, and whether it's waiting on them (it
// holds still). No faces, no sounds.

export type OrbState = "connecting" | "listening" | "on_it" | "working" | "speaking" | "your_call" | "stuck" | "ended";

export const ORB_LABEL: Record<OrbState, string> = {
  connecting: "Connecting…",
  listening: "Listening",
  on_it: "On it",
  working: "Working",
  speaking: "Speaking",
  your_call: "Your call",
  stuck: "Stuck",
  ended: "Call ended",
};

export function Orb({ state, size = 148 }: { state: OrbState; size?: number }) {
  const core =
    state === "stuck"
      ? "bg-danger/55"
      : state === "connecting" || state === "ended"
        ? "bg-accent/25"
        : state === "listening"
          ? "bg-accent/60 breathe-soft"
          : state === "speaking"
            ? "bg-accent orb-speak"
            : "bg-accent/80";
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} aria-hidden="true">
      {/* A turning arc while real progress streams in. */}
      <div
        className={`absolute inset-0 rounded-full transition-opacity duration-200 ${state === "working" ? "orb-turn opacity-100" : "opacity-0"}`}
        style={{ background: "conic-gradient(from 0deg, transparent 0deg, var(--accent) 70deg, transparent 140deg)" }}
      />
      <div className={`absolute inset-[3px] rounded-full bg-bg ${state === "your_call" ? "ring-2 ring-accent" : "ring-1 ring-line-strong"} transition-shadow duration-200`} />
      <div className={`absolute inset-[18%] rounded-full transition-[background-color,transform] duration-200 ${core}`} />
      {state === "on_it" ? <div className="settle-check absolute inset-[38%] rounded-full bg-bg/70" /> : null}
    </div>
  );
}

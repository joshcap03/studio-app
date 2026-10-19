"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { Companion as CompanionInfo, CompanionLook, CompanionStage } from "@/lib/types";

// The agent as one member knows it, drawn from the Studio diamond. A sketch in faint pencil at
// first, drawn in as they work together, complete (with a brass edge) once it knows them, and
// inked in its own tint with eyes once it has arrived. Moods only ever reflect real state:
// working while a run streams, needs you while something waits on the member, done when a turn
// has just finished, stuck when it failed. Pure SVG and CSS (cm-* in globals.css); still under
// reduced motion. Always decorative: whatever it shows is also said in text nearby.

export type CompanionMood = "idle" | "working" | "needs_you" | "done" | "stuck";

/** The member's companion for the agent they're in; null where it isn't shown. */
export const CompanionContext = createContext<CompanionInfo | null>(null);

export function useCompanion(): CompanionInfo | null {
  return useContext(CompanionContext);
}

type Point = readonly [number, number];

// Top, right, bottom, left, in a 32×32 box.
const SHAPES: Record<CompanionLook["shape"], { points: readonly [Point, Point, Point, Point]; round: number }> = {
  classic: { points: [[16, 3.5], [28.5, 16], [16, 28.5], [3.5, 16]], round: 3.4 },
  tall: { points: [[16, 2.5], [26.5, 16], [16, 29.5], [5.5, 16]], round: 3.2 },
  wide: { points: [[16, 5], [29.5, 16], [16, 27], [2.5, 16]], round: 3.2 },
  cushion: { points: [[16, 3.5], [28.5, 16], [16, 28.5], [3.5, 16]], round: 5.4 },
};

const EYES: Record<CompanionLook["shape"], { y: number; gap: number }> = {
  classic: { y: 15, gap: 3.6 },
  tall: { y: 14, gap: 3.2 },
  wide: { y: 15.5, gap: 4.1 },
  cushion: { y: 15, gap: 3.7 },
};

const toward = (a: Point, b: Point, by: number): Point => {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return [a[0] + ((b[0] - a[0]) * by) / length, a[1] + ((b[1] - a[1]) * by) / length];
};
const fmt = (p: Point) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;

function polygon(points: readonly Point[]): string {
  return `M${points.map(fmt).join(" L")} Z`;
}

/** The diamond with softened corners. */
function rounded(points: readonly Point[], r: number): string {
  const n = points.length;
  const parts = points.map((p, i) => {
    const before = toward(p, points[(i + n - 1) % n], r);
    const after = toward(p, points[(i + 1) % n], r);
    return { before, p, after };
  });
  return `M${fmt(parts[0].after)} ${parts
    .slice(1)
    .concat(parts[0])
    .map(({ before, p, after }) => `L${fmt(before)} Q${fmt(p)} ${fmt(after)}`)
    .join(" ")} Z`;
}

/** One pencil stroke from a to b that runs a little past both ends, the way a hand draws. */
function stroke(a: Point, b: Point, over: number, short = 0): string {
  return `M${fmt(toward(a, b, -over))} L${fmt(toward(b, a, short ? short : -over))}`;
}

const READY_SEEN = "lj.companion-ready:";

export function Companion({
  stage,
  look,
  mood = "idle",
  size = 22,
  seenKey,
  className = "",
}: {
  stage: CompanionStage;
  look: CompanionLook;
  mood?: CompanionMood;
  size?: number;
  /** Plays the brass trace the first time this agent is seen ready (per device). */
  seenKey?: string;
  className?: string;
}) {
  const { points, round } = SHAPES[look.shape];
  const [t, r, b, l] = points;
  const px = size <= 22 ? 1.3 : size <= 48 ? 1.5 : 2;
  const sw = (px * 32) / size;
  const [tracing, setTracing] = useState(false);

  useEffect(() => {
    if (stage !== "ready" || !seenKey) return;
    try {
      if (window.localStorage.getItem(READY_SEEN + seenKey)) return;
      window.localStorage.setItem(READY_SEEN + seenKey, "1");
    } catch {
      return;
    }
    setTracing(true);
  }, [stage, seenKey]);

  const working = mood === "working";
  const outline = polygon(points);
  const style = {
    "--cm-tint": `var(--${look.tint})`,
    // Spread blinks so two marks never blink together.
    "--cm-delay": `-${(look.seed % 60) / 10}s`,
  } as React.CSSProperties;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      style={style}
      className={`cm cm-${stage} cm-mood-${mood} shrink-0 overflow-visible ${className}`}
    >
      {stage === "arrived" ? (
        <g className="cm-body">
          <path d={rounded(points, round)} className="cm-fill" />
          <path d={rounded(points, round)} className="stroke-fg opacity-20" strokeWidth={sw * 0.7} transform="translate(0.3 0.25)" />
          <g className="cm-look">
            <Eyes shape={look.shape} mood={mood} size={size} />
          </g>
        </g>
      ) : stage === "ready" ? (
        <g strokeLinejoin="round">
          <path d={outline} className="fill-accent-soft stroke-accent" strokeWidth={sw} />
          {tracing ? <path d={outline} pathLength={1} className="cm-trace stroke-accent" strokeWidth={sw * 1.3} strokeLinecap="round" /> : null}
        </g>
      ) : stage === "drawn" ? (
        <g strokeLinecap="round" strokeLinejoin="round">
          <g className="stroke-fg-4" strokeWidth={sw * 0.6} strokeDasharray={`${sw} ${sw * 1.6}`}>
            <path d={`M${fmt([9, EYES[look.shape].y])} L${fmt([23, EYES[look.shape].y])}`} />
            <path d={`M16 ${t[1] + 4} L16 ${b[1] - 4}`} />
          </g>
          <path d={outline} className="stroke-fg-2" strokeWidth={sw} />
          <path d={stroke(r, b, 0.8)} className="stroke-fg-2 opacity-60" strokeWidth={sw * 0.8} />
        </g>
      ) : (
        <g className="cm-faint stroke-fg-3" strokeWidth={sw} strokeLinecap="round" strokeDasharray={size <= 22 ? undefined : `${6 * sw} ${0.9 * sw}`}>
          <path d={stroke(l, t, 0.9)} />
          <path d={stroke(t, r, 0.7, 2.6)} />
          <path d={stroke(r, b, 0.9)} />
          <path d={stroke(b, l, 0.6)} />
          <path d={stroke(toward(l, t, 1.5), toward(t, l, 3), 0)} className="opacity-50" transform="translate(0.5 0.4)" />
        </g>
      )}
      {working && stage !== "arrived" ? (
        <path
          d={outline}
          pathLength={1}
          className={`cm-drawing ${stage === "ready" ? "stroke-accent" : "stroke-fg-2"}`}
          strokeWidth={sw * 1.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
  );
}

function Eyes({ shape, mood, size }: { shape: CompanionLook["shape"]; mood: CompanionMood; size: number }) {
  const { y, gap } = EYES[shape];
  // Small marks get bigger eyes so they still read.
  const r = size <= 22 ? 2.1 : size <= 48 ? 1.8 : 1.55;
  if (mood === "done") {
    // Softened, content eyes for a moment after a turn lands.
    return (
      <g className="settle-check stroke-bg" strokeWidth={r * 0.9} strokeLinecap="round">
        {[-gap, gap].map((dx) => (
          <path key={dx} d={`M${16 + dx - r} ${y + r * 0.35} Q${16 + dx} ${y - r * 0.9} ${16 + dx + r} ${y + r * 0.35}`} />
        ))}
      </g>
    );
  }
  return (
    <g className="cm-eyes fill-bg">
      <ellipse cx={16 - gap} cy={y} rx={r * 0.85} ry={r * 1.2} />
      <ellipse cx={16 + gap} cy={y} rx={r * 0.85} ry={r * 1.2} />
    </g>
  );
}

/** What the mark means, said in words (a title, a screen reader label). */
export function companionHint(stage: CompanionStage, name: string | null): string {
  switch (stage) {
    case "sketch":
      return "Still getting to know you";
    case "drawn":
      return "Getting to know you";
    case "ready":
      return "Ready to introduce itself";
    case "arrived":
      return name ?? "Your agent";
  }
}

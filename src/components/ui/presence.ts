"use client";

import { useEffect, useState, type RefObject } from "react";

// Where the companion's attention is, shared by every mark the member can see. A card that waits
// on the member says so while it waits (`useWaitsOnMember`) and each mark glances toward it once;
// while the member types it watches the message box (`noteTyping`); and a fact it remembers
// travels into it as a spark (`sendSpark`), back out on Undo. Only ever real state, always
// decorative, and still under reduced motion.

type Gaze = { x: number; y: number };

const listeners = new Set<() => void>();
const marks = new Map<SVGSVGElement, { home: boolean }>();
let waiting: { el: Element; id: number } | null = null;
let typing: Element | null = null;
let typingTimer: ReturnType<typeof setTimeout> | undefined;
let nextId = 1;

const notify = () => listeners.forEach((l) => l());

const still = () => typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How far the eyes travel, in the mark's 32-unit box. */
const REACH = 1.6;
const GLANCE_MS = 1500;
const TYPING_MS = 1200;

/** A card waiting on the member registers while it waits; the newest one is what marks glance at. */
export function useWaitsOnMember(ref: RefObject<Element | null>, active: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    waiting = { el, id: nextId++ };
    notify();
    return () => {
      if (waiting?.el !== el) return;
      waiting = null;
      notify();
    };
  }, [ref, active]);
}

/** The member is typing in `el`: marks watch it until they pause. */
export function noteTyping(el: Element) {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    typing = null;
    notify();
  }, TYPING_MS);
  if (typing === el) return;
  typing = el;
  notify();
}

function toward(from: Element, to: Element): Gaze | null {
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  if (!a.width || !b.width) return null;
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const length = Math.hypot(dx, dy);
  if (length < 1) return null;
  return { x: (dx / length) * REACH, y: (dy / length) * REACH };
}

/**
 * A mark the member is looking at: where its eyes should point (null: as its mood has them).
 * `home` is the agent's own mark (the sidebar), the one a remembered fact travels to.
 */
export function usePresentMark(ref: RefObject<SVGSVGElement | null>, enabled: boolean, home = false): Gaze | null {
  const [gaze, setGaze] = useState<Gaze | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    marks.set(el, { home });
    let glancedAt = 0;
    let glanceTimer: ReturnType<typeof setTimeout> | undefined;
    let glancing = false;
    const update = () => {
      if (still()) return setGaze(null);
      if (typing) return setGaze(toward(el, typing));
      if (waiting && waiting.id !== glancedAt) {
        // A new card waiting on the member: look at it for a moment, then back.
        glancedAt = waiting.id;
        glancing = true;
        setGaze(toward(el, waiting.el));
        clearTimeout(glanceTimer);
        glanceTimer = setTimeout(() => {
          glancing = false;
          update();
        }, GLANCE_MS);
        return;
      }
      if (!glancing) setGaze(null);
    };
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
      marks.delete(el);
      clearTimeout(glanceTimer);
    };
  }, [ref, enabled, home]);
  return gaze;
}

function visible(el: Element): DOMRect | null {
  const r = el.getBoundingClientRect();
  if (!r.width || r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return null;
  return r;
}

/** The mark a fact travels to: the agent's own mark when it's on screen, else the nearest one. */
function markFor(origin: DOMRect): SVGSVGElement | null {
  let best: { el: SVGSVGElement; score: number } | null = null;
  for (const [el, { home }] of marks) {
    const r = visible(el);
    if (!r) continue;
    const score = (home ? 0 : 1e6) + Math.hypot(r.left - origin.left, r.top - origin.top);
    if (!best || score < best.score) best = { el, score };
  }
  return best?.el ?? null;
}

const SPARK =
  "pointer-events-none fixed top-0 left-0 z-50 size-1.5 rounded-full bg-accent shadow-[0_0_10px_2px_var(--accent-soft)]";

/**
 * A fact went in ("in": from `from` into the companion) or came back out on Undo ("out"). When it
 * lands, the mark takes it in with a small swell. Nothing happens when either end is off screen.
 */
export function sendSpark(from: Element, direction: "in" | "out") {
  if (still()) return;
  const origin = visible(from);
  if (!origin) return;
  const mark = markFor(origin);
  const target = mark ? visible(mark) : null;
  if (!mark || !target) return;
  const a = { x: origin.left + 7, y: origin.top + origin.height / 2 };
  const b = { x: target.left + target.width / 2, y: target.top + target.height / 2 };
  const [p0, p2] = direction === "in" ? [a, b] : [b, a];
  // An arc, lifted above the higher end.
  const p1 = { x: (p0.x + p2.x) / 2, y: Math.min(p0.y, p2.y) - Math.min(80, Math.hypot(p2.x - p0.x, p2.y - p0.y) * 0.25) };
  const ease = (t: number) => 1 - Math.pow(1 - t, 3);
  const frames: Keyframe[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = ease(i / 16);
    const u = 1 - t;
    const x = u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x - 3;
    const y = u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y - 3;
    const scale = direction === "in" ? 1 - 0.4 * t : 0.6 + 0.4 * t;
    frames.push({ transform: `translate(${x}px, ${y}px) scale(${scale})`, opacity: i === 0 ? 0 : i === 16 && direction === "out" ? 0 : 1 });
  }
  const spark = document.createElement("div");
  spark.className = SPARK;
  spark.setAttribute("aria-hidden", "true");
  document.body.appendChild(spark);
  const duration = Math.min(480, Math.max(280, Math.hypot(p2.x - p0.x, p2.y - p0.y) * 0.6));
  const run = spark.animate(frames, { duration, easing: "linear", fill: "forwards" });
  run.onfinish = () => {
    spark.remove();
    if (direction !== "in") return;
    mark.classList.remove("cm-took");
    void mark.getBoundingClientRect();
    mark.classList.add("cm-took");
  };
}

"use client";

import { Check, ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { MOVE_LABEL, type Move } from "@/lib/chat/move";
import type { JourneyStep } from "@/lib/types";

// A journey the agent reports with update_plan (the setup interview, a task's plan, any other
// work with several steps), shown as a slim rail that fills in step by step, with what each
// finished step gave the agent and, once it's said, what done means. Quiet on purpose: no score,
// just where things stand, what's next, and whose move it is. Renders only what it's given.

const segment: Record<JourneyStep["status"], string> = {
  done: "bg-accent",
  doing: "bg-accent/45",
  needs_you: "bg-accent/45",
  blocked: "bg-danger/50",
  todo: "bg-line-strong",
};

/** The step that's under way, or the first one not done. */
function current(steps: JourneyStep[]): number {
  const doing = steps.findIndex((s) => s.status === "doing" || s.status === "needs_you");
  return doing >= 0 ? doing : steps.findIndex((s) => s.status !== "done");
}

/**
 * Just the rail, one segment per step; the step under way breathes unless `still` (nothing is
 * running on it right now).
 */
export function JourneyBar({ steps, still = false, className = "" }: { steps: JourneyStep[]; still?: boolean; className?: string }) {
  const done = steps.filter((s) => s.status === "done").length;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={steps.length}
      aria-valuenow={done}
      aria-valuetext={`${done} of ${steps.length} steps done`}
      className={`flex gap-1 ${className}`}
    >
      {steps.map((s, i) => (
        <span
          key={i}
          className={`h-1 min-w-0 flex-1 rounded-full transition-colors duration-200 ${segment[s.status]} ${s.status === "doing" && !still ? "breathe-soft" : ""}`}
        />
      ))}
    </div>
  );
}

/** Every step, with what finishing it gave the agent; `still` as for JourneyBar. */
export function JourneyList({ steps, still = false }: { steps: JourneyStep[]; still?: boolean }) {
  const at = current(steps);
  return (
    <ol className="flex flex-col">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-2.5 py-1.5">
          <span className="mt-[3px] flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
            {s.status === "done" ? (
              <span className="flex size-4 items-center justify-center rounded-full bg-accent text-on-inverse">
                <Check size={10} strokeWidth={3} />
              </span>
            ) : i === at ? (
              <span className={`size-2 rounded-full bg-accent ${still ? "" : "breathe-soft"}`} />
            ) : (
              <span className={`size-2 rounded-full ${s.status === "blocked" ? "bg-danger/60" : "border border-line-strong"}`} />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className={`block text-[13.5px] leading-[1.45] ${s.status === "done" ? "text-fg-2" : i === at ? "font-medium text-fg" : "text-fg-3"}`}>
              {s.text}
              <span className="sr-only"> ({s.status === "needs_you" ? "waiting on you" : s.status})</span>
            </span>
            {s.note ? <span className="block text-[12.5px] leading-[1.45] text-fg-3 [overflow-wrap:anywhere]">{s.note}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** "Done means …" (after the journey's title, if any): one line until the rail is opened, then in full. */
export function JourneyGoal({ goal, heading = null, open }: { goal: string; heading?: ReactNode; open: boolean }) {
  return (
    <span className="flex w-full items-baseline gap-2 text-[12.5px]">
      {heading}
      <span key={goal} className={`min-w-0 flex-1 font-medium text-fg-2 animate-fade-in ${open ? "[overflow-wrap:anywhere]" : "truncate"}`}>
        Done means {goal}
      </span>
    </span>
  );
}

/**
 * The rail with the step under way named beside it ("Step 3 of 6 · Your résumé"); opens into the
 * whole list. `goal`, once the agent has said what done looks like, gets its own line above
 * ("Done means …"), cut to one line until it's opened. `title` names the journey when there's
 * room, e.g. "Setting up". `move` (src/lib/chat/move.ts) marks it when it's the member's call or
 * it's stuck, and holds it still unless the agent is working. `onClear`, where the member may
 * clear the plan (a conversation's own), puts a way to in the opened list.
 */
export function Journey({
  steps,
  title,
  goal,
  growing = false,
  move,
  onClear,
  className = "",
}: {
  steps: JourneyStep[];
  title?: string;
  goal?: string | null;
  /** The list grows as it goes (setup adds steps once it knows they're needed), so no "of N". */
  growing?: boolean;
  move?: Move;
  onClear?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (steps.length === 0) return null;
  const at = current(steps);
  const finished = at < 0;
  const mark = move === "your_call" || move === "stuck" ? move : null;
  const still = move !== undefined && move !== "working";
  const heading = title ? <span className="shrink-0 font-medium text-fg-2">{title}</span> : null;
  return (
    <section aria-label={title ?? (goal ? `Done means ${goal}` : "Progress")} className={`rounded-xl border border-line bg-surface ${className}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full flex-col gap-2 rounded-xl px-3.5 pt-2.5 pb-3 text-left transition-colors hover:bg-hover"
      >
        {goal ? <JourneyGoal goal={goal} heading={heading} open={open} /> : null}
        <span className="flex w-full items-baseline gap-2 text-[12.5px]">
          {goal ? null : heading}
          <span key={finished ? "done" : at} className="min-w-0 flex-1 truncate text-fg-3 animate-fade-in">
            {finished ? "All steps done" : `Step ${at + 1}${growing ? "" : ` of ${steps.length}`} · ${steps[at].text}`}
          </span>
          {mark ? (
            <span className={`inline-flex shrink-0 items-center gap-1.5 font-medium ${mark === "stuck" ? "text-danger" : "text-accent"}`}>
              <span className={`size-1.5 rounded-full ${mark === "stuck" ? "bg-danger" : "bg-accent"}`} aria-hidden="true" />
              {MOVE_LABEL[mark]}
            </span>
          ) : null}
          <ChevronDown size={14} className={`shrink-0 self-center text-fg-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
        </span>
        <JourneyBar steps={steps} still={still} />
      </button>
      {open ? (
        <div id={id} className="border-t border-line px-3.5 py-1.5 animate-fade-in">
          <JourneyList steps={steps} still={still} />
          {onClear ? (
            <div className="flex justify-end pb-1">
              <button
                type="button"
                onClick={onClear}
                className="rounded-md px-1.5 py-1 text-[12.5px] text-fg-3 transition-colors hover:bg-hover hover:text-fg"
              >
                Clear this plan
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

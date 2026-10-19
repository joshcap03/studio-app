"use client";

import { Check, ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import type { JourneyStep } from "@/lib/types";

// A journey the agent reports with update_plan (the setup interview, a task's plan), shown as a
// slim rail that fills in step by step, with what each finished step gave the agent. Quiet on
// purpose: no score, just where things stand and what's next. Renders only the steps it's given.

const segment: Record<JourneyStep["status"], string> = {
  done: "bg-accent",
  doing: "bg-accent/45 breathe-soft",
  needs_you: "bg-accent/45",
  blocked: "bg-danger/50",
  todo: "bg-line-strong",
};

/** The step that's under way, or the first one not done. */
function current(steps: JourneyStep[]): number {
  const doing = steps.findIndex((s) => s.status === "doing" || s.status === "needs_you");
  return doing >= 0 ? doing : steps.findIndex((s) => s.status !== "done");
}

/** Just the rail, one segment per step. */
export function JourneyBar({ steps, className = "" }: { steps: JourneyStep[]; className?: string }) {
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
        <span key={i} className={`h-1 min-w-0 flex-1 rounded-full transition-colors duration-500 ${segment[s.status]}`} />
      ))}
    </div>
  );
}

/** Every step, with what finishing it gave the agent. */
export function JourneyList({ steps }: { steps: JourneyStep[] }) {
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
              <span className="size-2 rounded-full bg-accent breathe-soft" />
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

/**
 * The rail with the step under way named beside it ("Step 3 of 6 · Your résumé"); opens into the
 * whole list. `title` names the journey when there's room, e.g. "Setting up".
 */
export function Journey({
  steps,
  title,
  growing = false,
  className = "",
}: {
  steps: JourneyStep[];
  title?: string;
  /** The list grows as it goes (setup adds steps once it knows they're needed), so no "of N". */
  growing?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (steps.length === 0) return null;
  const at = current(steps);
  const finished = at < 0;
  return (
    <section aria-label={title ?? "Progress"} className={`rounded-xl border border-line bg-surface ${className}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full flex-col gap-2 rounded-xl px-3.5 pt-2.5 pb-3 text-left transition-colors hover:bg-hover"
      >
        <span className="flex w-full items-baseline gap-2 text-[12.5px]">
          {title ? <span className="shrink-0 font-medium text-fg-2">{title}</span> : null}
          <span key={finished ? "done" : at} className="min-w-0 flex-1 truncate text-fg-3 animate-fade-in">
            {finished ? "All steps done" : `Step ${at + 1}${growing ? "" : ` of ${steps.length}`} · ${steps[at].text}`}
          </span>
          <ChevronDown size={14} className={`shrink-0 self-center text-fg-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
        </span>
        <JourneyBar steps={steps} />
      </button>
      {open ? (
        <div id={id} className="border-t border-line px-3.5 py-1.5 animate-fade-in">
          <JourneyList steps={steps} />
        </div>
      ) : null}
    </section>
  );
}

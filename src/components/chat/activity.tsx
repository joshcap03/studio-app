"use client";

import { Check, ChevronRight, Minus, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ActivityStep } from "@/lib/types";

// Execution activity reported by the agent backend. Only steps the backend actually sent
// are shown; when it sends none, a single generic "Working" indicator stands in.

const VISIBLE_WHILE_RUNNING = 6;

export function ActivityLog({ steps, running }: { steps: ActivityStep[]; running: boolean }) {
  const [open, setOpen] = useState(false);

  if (running) {
    const hidden = Math.max(0, steps.length - VISIBLE_WHILE_RUNNING);
    return (
      <div className="mb-4 animate-fade-in" aria-live="polite">
        <WorkingHeader since={steps[0]?.startedAt} />
        {steps.length > 0 && (
          <ol className="mt-2 space-y-1.5 border-l border-line pl-4">
            {hidden > 0 && <li className="text-[13px] text-fg-3">{hidden} earlier steps</li>}
            {steps.slice(hidden).map((step) => (
              <StepRow key={step.id} step={step} finished={false} />
            ))}
          </ol>
        )}
      </div>
    );
  }

  if (steps.length === 0) return null;
  const failed = steps.filter((s) => s.status === "failed").length;
  const cut = steps.filter((s) => s.status === "running").length;
  const duration = elapsed(steps);

  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="-ml-1.5 inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[13px] text-fg-3 transition-colors hover:bg-hover hover:text-fg-2"
      >
        {failed > 0 ? (
          <X size={13} className="text-danger" strokeWidth={2.25} />
        ) : cut > 0 ? (
          <Minus size={13} strokeWidth={2.25} />
        ) : (
          <Check size={13} strokeWidth={2.25} />
        )}
        <span>
          {steps.length} {steps.length === 1 ? "step" : "steps"}
          {failed > 0 ? ` · ${failed} failed` : cut > 0 ? " · stopped" : ""}
          {duration ? ` · ${duration}` : ""}
        </span>
        <ChevronRight size={13} className={`transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <ol className="mt-1.5 mb-1 ml-[5px] space-y-1.5 border-l border-line pl-4 animate-fade-in">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} finished />
          ))}
        </ol>
      )}
    </div>
  );
}

function WorkingHeader({ since }: { since?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const seconds = since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
  return (
    <div className="flex h-6 items-center gap-2.5 text-[13.5px]">
      <span className="breathe size-1.5 rounded-full bg-accent" aria-hidden="true" />
      <span className="text-shimmer font-medium">Working</span>
      {seconds >= 3 && <span className="text-fg-4 tabular-nums">{formatSeconds(seconds)}</span>}
    </div>
  );
}

function StepRow({ step, finished }: { step: ActivityStep; finished: boolean }) {
  // A step still "running" on a message that has ended was cut short.
  const stopped = finished && step.status === "running";
  return (
    <li className="flex items-start gap-2.5 text-[13.5px] leading-5 animate-fade-up">
      <span className="mt-[3px] flex size-3.5 shrink-0 items-center justify-center">
        {stopped ? (
          <Minus size={13} className="text-fg-4" />
        ) : step.status === "running" ? (
          <span className="spinner" aria-label="Running" />
        ) : step.status === "done" ? (
          <Check size={13} strokeWidth={2.25} className="text-fg-3" aria-label="Done" />
        ) : (
          <X size={13} strokeWidth={2.25} className="text-danger" aria-label="Failed" />
        )}
      </span>
      <span className="min-w-0">
        <span className={step.status === "running" && !stopped ? "text-fg" : "text-fg-2"}>{step.label}</span>
        {step.detail ? (
          <span className={`block text-[12.5px] ${step.status === "failed" ? "text-danger/80" : "text-fg-3"}`}>
            {step.detail}
          </span>
        ) : null}
      </span>
    </li>
  );
}

function elapsed(steps: ActivityStep[]): string | null {
  const start = Math.min(...steps.map((s) => s.startedAt));
  const end = Math.max(...steps.map((s) => s.endedAt ?? s.startedAt));
  const seconds = Math.round((end - start) / 1000);
  return seconds >= 1 ? formatSeconds(seconds) : null;
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

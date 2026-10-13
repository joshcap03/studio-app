"use client";

import { Check, ChevronRight, Minus, PanelRightOpen, X } from "lucide-react";
import { useEffect, useState } from "react";
import { appName } from "@/lib/apps";
import type { ActivityStep } from "@/lib/types";
import { AppGlyph } from "./app-glyph";
import { StepPreview } from "./step-preview";

// Execution activity reported by the agent backend, shown as the agent's visible work:
// what it is doing right now, in which app, and (on demand) the receipt of each step.
// Only steps the backend sent are shown; with none, a single "Working" indicator stands in.

const VISIBLE_WHILE_RUNNING = 6;

interface Props {
  steps: ActivityStep[];
  running: boolean;
  /** Opens the side work panel for this message (desktop). */
  onOpenPanel?: () => void;
}

export function ActivityLog({ steps, running, onOpenPanel }: Props) {
  const [open, setOpen] = useState(false);
  const visible = steps.filter((s) => !s.hidden);
  // The agent's own short lines ("Let me look through your emails") narrate the work; they
  // are not steps.
  const work = visible.filter((s) => s.action !== "note");
  const toolSteps = steps.filter((s) => s.action !== "note");

  if (running) {
    // One status line: the step in progress, else what the agent said it's doing, else
    // it's deciding what to do next.
    // Hidden plumbing steps still drive the status line, so a slow one is never invisible.
    const current = [...steps].reverse().find((s) => s.status === "running" && s.action !== "note");
    const note = [...visible].reverse().find((s) => s.action === "note");
    const status = current?.label ?? note?.label ?? "Thinking it through";
    const listed = work;
    const hiddenCount = Math.max(0, listed.length - VISIBLE_WHILE_RUNNING);
    return (
      <div className="mb-4 animate-fade-in" aria-live="polite">
        <WorkingHeader
          since={steps[0]?.startedAt}
          stepSince={current?.startedAt}
          app={current?.app === "agent" ? undefined : current?.app}
          status={status}
          onOpenPanel={onOpenPanel}
        />
        {listed.length > 0 && (
          <ol className="mt-2 space-y-0.5 border-l border-line pl-3">
            {hiddenCount > 0 && <li className="py-1 pl-1 text-[12.5px] text-fg-3">{hiddenCount} earlier steps</li>}
            {listed.slice(hiddenCount).map((step) => (
              <StepRow key={step.id} step={step} finished={false} />
            ))}
          </ol>
        )}
      </div>
    );
  }

  if (toolSteps.length === 0) return null;
  const failed = work.filter((s) => s.status === "failed").length;
  const cut = work.filter((s) => s.status === "running").length;
  const apps = [...new Set(work.map((s) => s.app).filter((a): a is string => !!a && a !== "agent"))];
  const duration = elapsed(steps);

  return (
    <div className="mb-4">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="-ml-1.5 inline-flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 text-[13px] text-fg-3 transition-colors hover:bg-hover hover:text-fg-2"
        >
          {apps.length > 0 ? (
            <span className="flex -space-x-1">
              {apps.slice(0, 4).map((app) => (
                <AppGlyph key={app} app={app} size={16} className="ring-2 ring-bg" />
              ))}
            </span>
          ) : failed > 0 ? (
            <X size={13} className="text-danger" strokeWidth={2.25} />
          ) : cut > 0 ? (
            <Minus size={13} strokeWidth={2.25} />
          ) : (
            <Check size={13} strokeWidth={2.25} />
          )}
          <span className="truncate">
            {apps.length > 0 ? `Used ${listApps(apps)} · ` : ""}
            {toolSteps.length} {toolSteps.length === 1 ? "step" : "steps"}
            {failed > 0 ? ` · ${failed} failed` : cut > 0 ? " · stopped" : ""}
            {duration ? ` · ${duration}` : ""}
          </span>
          <ChevronRight size={13} className={`shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
        </button>
        {onOpenPanel && work.length > 0 ? (
          <button
            type="button"
            onClick={onOpenPanel}
            aria-label="Show what it found"
            title="Show what it found"
            className="hidden size-7 items-center justify-center rounded-md text-fg-4 transition-colors hover:bg-hover hover:text-fg-2 min-[1180px]:inline-flex"
          >
            <PanelRightOpen size={14} />
          </button>
        ) : null}
      </div>
      {open && (
        <ol className="mt-1.5 mb-1 ml-[5px] space-y-0.5 border-l border-line pl-3 animate-fade-in">
          {work.length === 0 ? (
            <li className="py-1 pl-1 text-[12.5px] text-fg-3">Only internal steps (finding tools)</li>
          ) : (
            visible.map((step) =>
              step.action === "note" ? (
                <li key={step.id} className="py-1 pl-1 text-[13px] leading-5 text-fg-3">
                  {step.label}
                </li>
              ) : (
                <StepRow key={step.id} step={step} finished />
              ),
            )
          )}
        </ol>
      )}
    </div>
  );
}

const SLOW_STEP_SECONDS = 30;

function WorkingHeader({
  since,
  stepSince,
  app,
  status,
  onOpenPanel,
}: {
  since?: number;
  stepSince?: number;
  app?: string;
  status: string;
  onOpenPanel?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const seconds = since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
  const stepSeconds = stepSince ? Math.max(0, Math.floor((now - stepSince) / 1000)) : 0;
  const slow = stepSeconds >= SLOW_STEP_SECONDS;
  return (
    <div className="flex h-6 items-center gap-2.5 text-[13.5px]">
      {app ? (
        <AppGlyph app={app} size={16} className="breathe" />
      ) : (
        <span className="breathe size-1.5 rounded-full bg-accent" aria-hidden="true" />
      )}
      <span key={status} className="text-shimmer min-w-0 truncate font-medium animate-fade-in">
        {status}
      </span>
      {slow ? (
        <span className="shrink-0 text-[12.5px] text-fg-3 tabular-nums">· this step is taking a while · {formatSeconds(stepSeconds)}</span>
      ) : seconds >= 3 ? (
        <span className="shrink-0 text-fg-4 tabular-nums">{formatSeconds(seconds)}</span>
      ) : null}
      {onOpenPanel ? (
        <button
          type="button"
          onClick={onOpenPanel}
          aria-label="Show what it found"
          title="Show what it found"
          className="ml-auto hidden size-6 items-center justify-center rounded-md text-fg-4 hover:bg-hover hover:text-fg-2 min-[1180px]:inline-flex"
        >
          <PanelRightOpen size={13} />
        </button>
      ) : null}
    </div>
  );
}

export function StepRow({ step, finished, defaultOpen = false }: { step: ActivityStep; finished: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  // A step still "running" on a message that has ended was cut short.
  const stopped = finished && step.status === "running";
  const expandable = Boolean(step.preview || step.detail);

  const status = stopped ? (
    <Minus size={12} className="text-fg-4" aria-label="Stopped" />
  ) : step.status === "running" ? (
    <span className="spinner" aria-label="Running" />
  ) : step.status === "done" ? (
    <Check size={12} strokeWidth={2.5} className="text-fg-4" aria-label="Done" />
  ) : (
    <X size={12} strokeWidth={2.5} className="text-danger" aria-label="Failed" />
  );

  const row = (
    <>
      <AppGlyph app={step.app} size={18} />
      <span className={`min-w-0 flex-1 truncate ${step.status === "running" && !stopped ? "text-fg" : "text-fg-2"}`}>{step.label}</span>
      <span className="flex size-3.5 shrink-0 items-center justify-center">{status}</span>
      {expandable ? <ChevronRight size={12} className={`shrink-0 text-fg-4 transition-transform ${open ? "rotate-90" : ""}`} /> : <span className="w-3" />}
    </>
  );

  return (
    <li className="animate-fade-up">
      {expandable ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-2.5 rounded-md py-1 pr-1 pl-1 text-left text-[13.5px] leading-5 transition-colors hover:bg-hover"
        >
          {row}
        </button>
      ) : (
        <div className="flex items-center gap-2.5 py-1 pr-1 pl-1 text-[13.5px] leading-5">{row}</div>
      )}
      {open ? (
        <div className="mt-1 mb-2 ml-[29px] space-y-2 animate-fade-in">
          {step.detail ? <p className={`text-[12.5px] ${step.status === "failed" ? "text-danger" : "text-fg-3"}`}>{step.detail}</p> : null}
          {step.preview ? <StepPreview preview={step.preview} /> : null}
        </div>
      ) : null}
    </li>
  );
}

function listApps(apps: string[]): string {
  const names = apps.map((a) => appName(a));
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]}`;
  return `${names.slice(0, 2).join(", ")}, and ${names.length - 2} more`;
}

function elapsed(steps: ActivityStep[]): string | null {
  const start = Math.min(...steps.map((s) => s.startedAt));
  const end = Math.max(...steps.map((s) => s.endedAt ?? s.startedAt));
  const seconds = Math.round((end - start) / 1000);
  return seconds >= 1 ? formatSeconds(seconds) : null;
}

export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

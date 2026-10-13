"use client";

import { Check, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChatMessage } from "@/lib/types";
import { formatSeconds, StepRow } from "./activity";
import { AppGlyph } from "./app-glyph";
import { StepPreview } from "./step-preview";

/**
 * Side panel that follows the agent's work: the step happening now, shown large with its
 * receipt, and every step below. Desktop only; on smaller screens the inline timeline
 * carries the same information.
 */
export function WorkPanel({ message, onClose }: { message: ChatMessage | null; onClose: () => void }) {
  const steps = message?.activity.filter((s) => !s.hidden) ?? [];
  const running = message?.status === "streaming";
  const focus =
    [...steps].reverse().find((s) => s.status === "running") ??
    [...steps].reverse().find((s) => s.preview) ??
    steps.at(-1);

  return (
    <aside
      aria-label="Agent work"
      className="hidden w-[380px] shrink-0 flex-col border-l border-line bg-bg min-[1180px]:flex animate-fade-in"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 pr-2 pl-5">
        <h2 className="text-[14px] font-semibold tracking-[-0.01em]">Work</h2>
        <Status message={message} />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close work view"
          className="ml-auto flex size-8 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-hover hover:text-fg"
        >
          <X size={16} />
        </button>
      </header>

      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        {!message || steps.length === 0 ? (
          <p className="mt-6 text-[13.5px] leading-relaxed text-fg-3">
            {running ? "Steps appear here as the agent works." : "This reply didn't use any tools."}
          </p>
        ) : (
          <>
            {focus ? (
              <section key={focus.id} className="mt-1 rounded-xl border border-line bg-surface p-4 shadow-composer animate-fade-in">
                <div className="flex items-center gap-2.5">
                  <AppGlyph app={focus.app} size={24} className={focus.status === "running" ? "breathe" : ""} />
                  <p className="min-w-0 flex-1 text-[14px] leading-snug font-medium text-fg">{focus.label}</p>
                  {focus.status === "running" && running ? <span className="spinner" aria-label="Running" /> : null}
                  {focus.status === "failed" ? <X size={14} className="text-danger" aria-label="Failed" /> : null}
                  {focus.status === "done" ? <Check size={14} className="text-fg-3" aria-label="Done" /> : null}
                </div>
                {focus.detail ? <p className="mt-3 text-[13px] text-danger">{focus.detail}</p> : null}
                {focus.preview ? (
                  <div className="mt-4">
                    <StepPreview preview={focus.preview} size="panel" />
                  </div>
                ) : focus.status === "running" ? (
                  <p className="mt-3 text-[13px] text-fg-3">Waiting for results…</p>
                ) : null}
              </section>
            ) : null}

            <h3 className="mt-7 mb-1.5 text-[11.5px] font-medium text-fg-3">All steps</h3>
            <ol className="space-y-0.5">
              {steps.map((step) => (
                <StepRow key={step.id} step={step} finished={!running} />
              ))}
            </ol>
          </>
        )}
      </div>
    </aside>
  );
}

function Status({ message }: { message: ChatMessage | null }) {
  const running = message?.status === "streaming";
  const since = message?.activity[0]?.startedAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  if (!message) return null;
  if (running) {
    return (
      <span className="flex items-center gap-1.5 text-[12.5px] text-fg-3">
        <span className="breathe size-1.5 rounded-full bg-accent" aria-hidden="true" />
        Working{since ? ` · ${formatSeconds(Math.max(0, Math.floor((now - since) / 1000)))}` : ""}
      </span>
    );
  }
  const count = message.activity.length;
  return <span className="text-[12.5px] text-fg-3">{count ? `${count} ${count === 1 ? "step" : "steps"}` : ""}</span>;
}

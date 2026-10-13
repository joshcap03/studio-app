"use client";

import { ArrowUpRight, ChevronRight, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChatMessage } from "@/lib/types";
import { formatSeconds } from "./activity";
import { AppGlyph } from "./app-glyph";
import { findingFor, findingForArtifact, type Finding } from "./findings";
import { StepPreview } from "./step-preview";

/**
 * What the agent found, one line per discovery: the emails it saw, the sources it read,
 * what it remembered, what it made. The chat timeline already says what the agent is
 * doing; this panel never repeats it. Click a line for the full receipt. Desktop only.
 */
export function WorkPanel({ message, onClose }: { message: ChatMessage | null; onClose: () => void }) {
  const findings = message ? collectFindings(message) : [];

  return (
    <aside
      aria-label="What the agent found"
      className="hidden w-[380px] shrink-0 flex-col border-l border-line bg-bg min-[1180px]:flex animate-fade-in"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 pr-2 pl-5">
        <h2 className="text-[14px] font-semibold tracking-[-0.01em]">Found</h2>
        <Status message={message} />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto flex size-8 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-hover hover:text-fg"
        >
          <X size={16} />
        </button>
      </header>

      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-3 pb-8">
        {findings.length === 0 ? (
          <p className="mt-2 px-2 text-[13.5px] leading-relaxed text-fg-3">
            {message?.status === "streaming" ? "What it finds will show up here." : "Nothing to show for this reply."}
          </p>
        ) : (
          <ol className="space-y-0.5">
            {findings.map((finding) => (
              <FindingRow key={finding.id} finding={finding} />
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}

export function collectFindings(message: ChatMessage): Finding[] {
  const fromSteps = message.activity.filter((s) => !s.hidden).flatMap((s) => findingFor(s) ?? []);
  return [...fromSteps, ...message.artifacts.map(findingForArtifact)];
}

function FindingRow({ finding }: { finding: Finding }) {
  const [open, setOpen] = useState(false);
  const preview = finding.step?.preview;
  const problem = finding.tone === "problem";

  if (finding.artifact?.url) {
    return (
      <li className="animate-fade-up">
        <a
          href={finding.artifact.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-start gap-2.5 rounded-lg px-2 py-2 text-[13.5px] leading-snug text-fg transition-colors hover:bg-hover"
        >
          <AppGlyph app={finding.app} size={18} className="mt-px" />
          <span className="min-w-0 flex-1">{finding.text}</span>
          <ArrowUpRight size={14} className="mt-0.5 shrink-0 text-fg-3" />
        </a>
      </li>
    );
  }

  return (
    <li className="animate-fade-up">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={preview ? open : undefined}
        disabled={!preview}
        className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left text-[13.5px] leading-snug transition-colors enabled:hover:bg-hover"
      >
        <AppGlyph app={finding.app} size={18} className="mt-px" />
        <span className={`min-w-0 flex-1 ${problem ? "text-danger" : "text-fg"}`}>{finding.text}</span>
        {preview ? <ChevronRight size={13} className={`mt-1 shrink-0 text-fg-4 transition-transform ${open ? "rotate-90" : ""}`} /> : null}
      </button>
      {open && preview ? (
        <div className="mt-1 mb-3 ml-[38px] mr-2 animate-fade-in">
          <StepPreview preview={preview} size="panel" />
        </div>
      ) : null}
    </li>
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
  if (!running) return null;
  return (
    <span className="flex items-center gap-1.5 text-[12.5px] text-fg-3">
      <span className="breathe size-1.5 rounded-full bg-accent" aria-hidden="true" />
      {since ? formatSeconds(Math.max(0, Math.floor((now - since) / 1000))) : "Working"}
    </span>
  );
}

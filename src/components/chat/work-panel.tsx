"use client";

import { ArrowUpRight, ChevronRight, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/types";
import { formatSeconds } from "./activity";
import { AppGlyph } from "./app-glyph";
import { findingsForReply, type Finding } from "./findings";
import { StepPreview } from "./step-preview";

/**
 * Everything the agent has found and made in this conversation, one line per discovery,
 * grouped under the question that led to it. The chat says what the agent is doing; this
 * panel is the conversation's record of what it saw. Click a line for the receipt.
 * Desktop only.
 */
export function WorkPanel({
  messages,
  focusId,
  onClose,
}: {
  messages: ChatMessage[];
  /** Reply to bring into view (from its "show what it found" button). */
  focusId: string | null;
  onClose: () => void;
}) {
  const groups = groupFindings(messages);
  const running = messages.find((m) => m.role === "assistant" && m.status === "streaming");
  const count = groups.reduce((n, g) => n + g.findings.length, 0);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow new findings while the reader is at the bottom; jump to a requested reply.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (focusId) {
      el.querySelector(`[data-reply="${focusId}"]`)?.scrollIntoView({ block: "start" });
      stick.current = false;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [count, focusId]);

  return (
    <aside
      aria-label="What the agent found"
      className="hidden w-[380px] shrink-0 flex-col border-l border-line bg-bg min-[1180px]:flex animate-fade-in"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 pr-2 pl-5">
        <h2 className="text-[14px] font-semibold tracking-[-0.01em]">Found</h2>
        {running ? <Elapsed since={running.activity[0]?.startedAt} /> : count > 0 ? <span className="text-[12.5px] text-fg-3">{count}</span> : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto flex size-8 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-hover hover:text-fg"
        >
          <X size={16} />
        </button>
      </header>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-3 pb-8"
      >
        {groups.length === 0 ? (
          <p className="mt-2 px-2 text-[13.5px] leading-relaxed text-fg-3">
            {running ? "What it finds will show up here." : "Nothing found in this conversation yet."}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.replyId} data-reply={group.replyId} className="mb-5 scroll-mt-2 last:mb-0">
              <h3 className="truncate px-2 pt-1 pb-1.5 text-[12px] text-fg-3" title={group.question}>
                {group.question}
              </h3>
              <ol className="space-y-0.5">
                {group.findings.map((finding) => (
                  <FindingRow key={finding.id} finding={finding} />
                ))}
              </ol>
            </section>
          ))
        )}
      </div>
    </aside>
  );
}

interface Group {
  replyId: string;
  question: string;
  findings: Finding[];
}

/** Findings for one reply: what its steps found, then the files it made. */
export function collectFindings(message: ChatMessage): Finding[] {
  return findingsForReply(message.activity, message.artifacts);
}

function groupFindings(messages: ChatMessage[]): Group[] {
  const groups: Group[] = [];
  let question = "";
  for (const m of messages) {
    if (m.role === "user") {
      question = m.content.replace(/\s+/g, " ").trim();
      continue;
    }
    const findings = collectFindings(m).map((f) => ({ ...f, id: `${m.id}:${f.id}` }));
    if (findings.length > 0) groups.push({ replyId: m.id, question: question || "Earlier", findings });
  }
  return groups;
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
        <div className="mt-1 mb-3 mr-2 ml-[38px] animate-fade-in">
          <StepPreview preview={preview} size="panel" />
        </div>
      ) : null}
    </li>
  );
}

function Elapsed({ since }: { since?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="flex items-center gap-1.5 text-[12.5px] text-fg-3">
      <span className="breathe size-1.5 rounded-full bg-accent" aria-hidden="true" />
      {since ? formatSeconds(Math.max(0, Math.floor((now - since) / 1000))) : "Working"}
    </span>
  );
}

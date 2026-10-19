"use client";

import { ArrowUpRight, ChevronRight, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage, Timeline } from "@/lib/types";
import { formatSeconds } from "./activity";
import { AppGlyph } from "./app-glyph";
import { chunkFindings, findingsForReply, type Chunk, type Finding, type ResearchChunk } from "./findings";
import { StepPreview } from "./step-preview";
import { VisualView } from "./visuals";

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
  /** Reply to bring into view (from its "Show results" button). */
  focusId: string | null;
  onClose: () => void;
}) {
  const groups = groupFindings(messages);
  const running = messages.find((m) => m.role === "assistant" && m.status === "streaming");
  const count = groups.reduce((n, g) => n + g.findings.length + (g.timeline?.entries.length ?? 0) + (g.timeline?.visuals?.length ?? 0), 0);
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
      aria-label="Results"
      className="hidden w-[380px] shrink-0 flex-col border-l border-line bg-bg min-[1180px]:flex animate-fade-in"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 pr-2 pl-5">
        <h2 className="text-[14px] font-semibold tracking-[-0.01em]">Results</h2>
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
            {running ? "What the agent finds and makes will show up here." : "No results in this conversation yet."}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.replyId} data-reply={group.replyId} className="mb-5 scroll-mt-2 last:mb-0">
              <h3 className="truncate px-2 pt-1 pb-1.5 text-[12px] text-fg-3" title={group.question}>
                {group.question}
              </h3>
              {group.timeline?.visuals?.map((visual, i) => <VisualView key={i} visual={visual} />)}
              {group.timeline && (group.timeline.entries.length > 0 || group.timeline.causes.length > 0) ? (
                <TimelineView timeline={group.timeline} />
              ) : null}
              <Chunks chunks={chunkFindings(group.findings)} />
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
  timeline?: Timeline | null;
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
    if (findings.length > 0 || m.timeline) groups.push({ replyId: m.id, question: question || "Earlier", findings, timeline: m.timeline });
  }
  return groups;
}

/**
 * An investigation: dated events across the member's apps, each linking to the record
 * it came from when this run's tools returned that link, then the likely causes. Its
 * charts, key numbers, and tables are drawn above it (see VisualView).
 */
function TimelineView({ timeline }: { timeline: Timeline }) {
  return (
    <div className="mb-3 rounded-xl border border-line bg-surface px-2 pt-2.5 pb-1 animate-fade-up">
      {timeline.entries.length > 0 ? <h4 className="px-2 text-[12px] font-medium text-fg-2">Timeline</h4> : null}
      <ol className="relative mt-1.5 empty:hidden">
        {timeline.entries.map((entry, i) => {
          const body = (
            <>
              <AppGlyph app={entry.app} size={18} className="mt-px" />
              <span className="min-w-0 flex-1">
                <span className="block text-[11.5px] text-fg-3 tabular-nums">
                  <span className="mr-1.5 text-fg-4">{i + 1}</span>
                  {formatWhen(entry.when)}
                </span>
                <span className={entry.verified ? "text-fg" : "text-fg-2"}>{entry.what}</span>
                {entry.verified ? null : <span className="block text-[11.5px] text-fg-4">No record linked</span>}
              </span>
              {entry.url ? <ArrowUpRight size={14} className="mt-0.5 shrink-0 text-fg-3" /> : null}
            </>
          );
          const row = "flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-[13.5px] leading-snug";
          return (
            <li key={i}>
              {entry.url ? (
                <a href={entry.url} target="_blank" rel="noopener noreferrer" className={`${row} transition-colors hover:bg-hover`}>
                  {body}
                </a>
              ) : (
                <div className={row}>{body}</div>
              )}
            </li>
          );
        })}
      </ol>
      {timeline.causes.length > 0 ? (
        <div className={`px-2 pb-2 ${timeline.entries.length > 0 ? "mt-1 border-t border-line pt-2.5" : "pt-0.5"}`}>
          <h4 className="text-[12px] font-medium text-fg-2">Likely causes</h4>
          <ol className="mt-1.5 space-y-1.5">
            {timeline.causes.map((cause, i) => (
              <li key={i} className="text-[13.5px] leading-snug text-fg">
                {cause.text}
                {cause.entries.length > 0 ? (
                  <span className="ml-1.5 text-[11.5px] text-fg-3 tabular-nums">({cause.entries.map((e) => e + 1).join(", ")})</span>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

/** "2026-10-06" → "Tue, Oct 6"; anything unparseable is shown as reported. */
function formatWhen(when: string): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(when);
  const at = Date.parse(dateOnly ? `${when}T12:00:00` : when);
  if (Number.isNaN(at)) return when;
  const date = new Date(at);
  const day = date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return dateOnly ? day : `${day}, ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

/** Results this many deep show the first few and fold the rest behind "Show more". */
const FOLD_AFTER = 8;
const FOLDED_SHOW = 6;

function Chunks({ chunks }: { chunks: Chunk[] }) {
  const [all, setAll] = useState(false);
  const results = chunks.filter((c) => c.kind === "finding").length;
  const hide = !all && results > FOLD_AFTER ? results - FOLDED_SHOW : 0;
  let shown = 0;
  return (
    <ol className="space-y-0.5">
      {chunks.map((chunk) => {
        if (chunk.kind === "research") return <ResearchRow key={chunk.id} chunk={chunk} />;
        if (hide && shown++ >= FOLDED_SHOW) {
          return shown === FOLDED_SHOW + 1 ? (
            <li key="more">
              <button
                type="button"
                onClick={() => setAll(true)}
                className="w-full rounded-lg py-1.5 pr-2 pl-[38px] text-left text-[12.5px] text-fg-3 transition-colors hover:bg-hover hover:text-fg"
              >
                Show {hide} more
              </button>
            </li>
          ) : null;
        }
        return <FindingRow key={chunk.finding.id} finding={chunk.finding} />;
      })}
    </ol>
  );
}

/** The looking behind the results, folded to one line: every source read, or each lookup. */
function ResearchRow({ chunk }: { chunk: ResearchChunk }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="animate-fade-up">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left text-[13.5px] leading-snug transition-colors hover:bg-hover"
      >
        <AppGlyph app={chunk.app} size={18} className="mt-px" />
        <span className="min-w-0 flex-1">
          <span className="block text-fg-2">{chunk.text}</span>
          {chunk.detail ? <span className="block truncate text-[12px] text-fg-3">{chunk.detail}</span> : null}
        </span>
        <ChevronRight size={13} className={`mt-1 shrink-0 text-fg-4 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open ? (
        chunk.sources ? (
          <div className="mt-1 mb-3 mr-2 ml-[38px] animate-fade-in">
            <StepPreview preview={chunk.sources} size="panel" />
          </div>
        ) : (
          <ol className="mb-2 ml-[28px] space-y-0.5 animate-fade-in">
            {chunk.findings.map((finding) => (
              <FindingRow key={finding.id} finding={finding} />
            ))}
          </ol>
        )
      ) : null}
    </li>
  );
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

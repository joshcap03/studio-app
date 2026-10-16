"use client";

import { ArrowUpRight } from "lucide-react";
import { createContext, useContext } from "react";
import type { Citation } from "@/lib/types";
import { AppGlyph } from "./app-glyph";

// Numbered citations in an answer. Each [n] the agent wrote becomes a small number; clicking
// it opens a card under that paragraph with the quoted passage and a link that opens the
// source at that passage. Only citations the server checked against this run's tool results
// exist here (see src/lib/chat/citations.ts); a link-only one says its quote wasn't found.

interface CitationState {
  citations: Map<number, Citation>;
  open: number | null;
  setOpen: (n: number | null) => void;
}

export const CitationContext = createContext<CitationState | null>(null);

export function CitationChip({ n }: { n: number }) {
  const state = useContext(CitationContext);
  const citation = state?.citations.get(n);
  if (!state || !citation) return null;
  const open = state.open === n;
  return (
    <button
      type="button"
      onClick={() => state.setOpen(open ? null : n)}
      aria-expanded={open}
      aria-label={`Source ${n}: ${citation.title ?? domain(citation.url)}`}
      className={`ml-[3px] inline-flex h-[17px] min-w-[17px] translate-y-[-2px] items-center justify-center rounded-full px-[5px] align-middle text-[10.5px] font-medium leading-none tabular-nums transition-colors ${
        citation.quoteVerified ? "bg-accent-soft text-accent hover:bg-accent/20" : "bg-subtle text-fg-3 hover:bg-hover"
      } ${open ? "ring-1 ring-accent" : ""}`}
    >
      {n}
    </button>
  );
}

/** The open citation's card, shown under the paragraph that cites it. */
export function CitationCard({ citation }: { citation: Citation }) {
  const state = useContext(CitationContext);
  return (
    <div className="not-prose my-2 rounded-xl border border-line bg-surface px-3.5 py-3 text-[13px] leading-snug animate-fade-up">
      <div className="flex items-center gap-2">
        <AppGlyph app={citation.app ?? "web"} size={18} />
        <span className="min-w-0 truncate font-medium text-fg">{citation.title ?? domain(citation.url)}</span>
        <span className="shrink-0 text-fg-3">{domain(citation.url)}</span>
        <span
          className={`ml-auto shrink-0 rounded-md px-2 py-0.5 text-[11.5px] ${
            citation.quoteVerified ? "bg-success/10 text-success" : "bg-subtle text-fg-3"
          }`}
        >
          {citation.quoteVerified ? "Quote found in source" : "Linked source; quote not confirmed"}
        </span>
      </div>
      <blockquote className="mt-2 border-l-2 border-line-strong pl-3 text-fg-2">“{citation.quote}”</blockquote>
      <div className="mt-2.5 flex items-center gap-1">
        <a
          href={sourceHref(citation)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-7 items-center gap-1 rounded-lg border border-line px-2.5 text-[12.5px] text-fg-2 transition-colors hover:bg-hover hover:text-fg"
        >
          {canHighlight(citation) ? "Open at this passage" : "Open source"}
          <ArrowUpRight size={13} />
        </a>
        <button
          type="button"
          onClick={() => state?.setOpen(null)}
          className="h-7 rounded-lg px-2.5 text-[12.5px] text-fg-3 transition-colors hover:bg-hover hover:text-fg"
        >
          Close
        </button>
      </div>
    </div>
  );
}

/** The numbered sources under an answer. */
export function SourceList({ citations }: { citations: Citation[] }) {
  return (
    <section aria-label="Sources" className="mt-4">
      <h4 className="mb-1 text-[12px] text-fg-3">Sources</h4>
      <ol>
        {citations.map((c) => (
          <li key={c.n}>
            <a
              href={sourceHref(c)}
              target="_blank"
              rel="noopener noreferrer"
              className="-mx-2 flex items-center gap-2.5 rounded-lg px-2 py-1 text-[13px] transition-colors hover:bg-hover"
            >
              <span className={`w-4 shrink-0 text-right text-[11.5px] tabular-nums ${c.quoteVerified ? "text-accent" : "text-fg-4"}`}>{c.n}</span>
              <AppGlyph app={c.app ?? "web"} size={16} />
              <span className="min-w-0 truncate text-fg">{c.title ?? domain(c.url)}</span>
              <span className="shrink-0 text-fg-3">{domain(c.url)}</span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Web pages open scrolled to the quoted passage (a text fragment); app records open as is. */
export function sourceHref(citation: Citation): string {
  if (!canHighlight(citation)) return citation.url;
  const words = citation.quote.replace(/[“”"…]/g, "").trim().split(/\s+/);
  const enc = (s: string) => encodeURIComponent(s).replace(/-/g, "%2D").replace(/,/g, "%2C");
  // Long passages match more reliably as "start,end".
  const fragment = words.length > 12 ? `${enc(words.slice(0, 5).join(" "))},${enc(words.slice(-5).join(" "))}` : enc(words.join(" "));
  return `${citation.url}#:~:text=${fragment}`;
}

function canHighlight(citation: Citation): boolean {
  return citation.quoteVerified && !citation.url.includes("#") && (citation.app === undefined || citation.app === "web" || citation.app === "browser");
}

function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

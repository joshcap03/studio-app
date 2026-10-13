"use client";

import { ArrowUpRight, Check, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { StepPreview as Preview } from "@/lib/types";

// The receipt for one agent step: what it actually found, read, wrote, or ran. Built on the
// server from the tool call's real input and output (sanitized and capped).

export function StepPreview({ preview, size = "inline" }: { preview: Preview; size?: "inline" | "panel" }) {
  const panel = size === "panel";
  switch (preview.type) {
    case "sources":
      return (
        <ul className={`space-y-1 ${panel ? "text-[13.5px]" : "text-[13px]"}`}>
          {preview.items.map((s) => (
            <li key={s.url}>
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group/src flex items-baseline gap-2 rounded-md px-1.5 py-1 -mx-1.5 transition-colors hover:bg-hover"
              >
                <span className="min-w-0 flex-1 truncate text-fg">{s.title}</span>
                <span className="shrink-0 text-[12px] text-fg-3">{s.domain}</span>
              </a>
            </li>
          ))}
          <More total={preview.total} shown={preview.items.length} noun="results" />
        </ul>
      );
    case "items":
      return (
        <ul className={`divide-y divide-line ${panel ? "text-[13.5px]" : "text-[13px]"}`}>
          {preview.items.map((item, i) => {
            const body = (
              <>
                <span className="block truncate text-fg">{item.primary}</span>
                {item.secondary ? <span className="block truncate text-[12px] text-fg-3">{item.secondary}</span> : null}
              </>
            );
            return (
              <li key={i} className="py-1.5 first:pt-0 last:pb-0">
                {item.url ? (
                  <a href={item.url} target="_blank" rel="noopener noreferrer" className="block rounded-md hover:text-fg">
                    {body}
                  </a>
                ) : (
                  body
                )}
              </li>
            );
          })}
          <More total={preview.total} shown={preview.items.length} noun="items" />
        </ul>
      );
    case "table":
      return (
        <div>
          {preview.title ? <p className="mb-1.5 text-[12px] font-medium text-fg-3">{preview.title}</p> : null}
          <div className="scroll-quiet max-h-72 overflow-auto rounded-lg border border-line">
            <table className="w-full border-collapse text-[12.5px] tabular-nums">
              <thead className="sticky top-0 bg-subtle">
                <tr>
                  {preview.columns.map((c, i) => (
                    <th key={i} className="border-b border-line px-2.5 py-1.5 text-left font-medium whitespace-nowrap text-fg-2">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, r) => (
                  <tr key={r} className="animate-fade-in">
                    {preview.columns.map((_, c) => (
                      <td key={c} className="border-b border-line px-2.5 py-1.5 whitespace-nowrap text-fg last:border-r-0">
                        {row[c] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <More total={preview.total} shown={preview.rows.length} noun="rows" />
        </div>
      );
    case "code":
      return (
        <CodePreview code={preview.code} output={preview.output} steps={preview.steps} language={preview.language} defaultOpen={false} />
      );
    case "text":
      return (
        <p className={`border-l-2 border-line-strong pl-3 whitespace-pre-wrap text-fg-2 ${panel ? "text-[13.5px]" : "text-[13px]"} leading-relaxed`}>
          {preview.text}
        </p>
      );
    case "link":
      return (
        <a
          href={preview.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] text-fg transition-colors hover:border-line-strong"
        >
          <span className="truncate">{preview.title ?? preview.url}</span>
          <ArrowUpRight size={13} className="shrink-0 text-fg-3" />
        </a>
      );
  }
}

function More({ total, shown, noun }: { total?: number; shown: number; noun: string }) {
  if (!total || total <= shown) return null;
  return <p className="pt-1.5 text-[12px] text-fg-3">+{total - shown} more {noun}</p>;
}

function CodePreview({
  code,
  output,
  steps,
  language,
  defaultOpen,
}: {
  code: string;
  output?: string;
  steps?: string[];
  language: string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="space-y-2">
      {steps ? (
        <ol className="space-y-1">
          {steps.map((step, i) => (
            <li key={i} className="flex items-start gap-2 text-[13px] text-fg animate-fade-up" style={{ animationDelay: `${i * 70}ms` }}>
              <Check size={13} strokeWidth={2.5} className="mt-[3px] shrink-0 text-success" />
              <span>{step}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {/* Code and raw output are technical details: shown only on request. */}
      {output && open ? (
        <pre className="scroll-quiet max-h-56 overflow-auto rounded-lg bg-subtle px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-fg">
          {output}
        </pre>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[12px] text-fg-3 hover:text-fg-2"
      >
        <ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        {open ? "Hide" : "Show"} technical details
      </button>
      {open ? (
        <pre className="scroll-quiet max-h-72 overflow-auto rounded-lg border border-line px-3 py-2 font-mono text-[12px] leading-relaxed text-fg-2">
          {code}
        </pre>
      ) : null}
    </div>
  );
}

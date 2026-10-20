"use client";

import { ArrowUpRight, AudioLines } from "lucide-react";
import { callLength, type CallRecap } from "@/lib/voice/recap";

// After a call, what it came to, in the chat under its last message: what the member asked in
// their own words, what got done, what they decided, and what's still out. Built in the browser
// from the records (src/lib/voice/recap.ts), so it changes as a job that was still going lands.

export function CallRecapCard({ recap }: { recap: CallRecap }) {
  const sections: { title: string; items: React.ReactNode[] }[] = [
    { title: "You asked", items: recap.asked.map((words) => <span className="line-clamp-3">“{words}”</span>) },
    {
      title: "I did",
      items: [
        ...recap.did.map((step) => <span className={step.failed ? "text-danger" : undefined}>{step.label}</span>),
        ...(recap.moreDone ? [<span className="text-fg-3">and {recap.moreDone} more</span>] : []),
        ...recap.made.map((file) =>
          file.url ? (
            <a href={file.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-medium text-fg underline-offset-2 hover:underline">
              {file.title}
              <ArrowUpRight size={12} className="shrink-0" />
            </a>
          ) : (
            <span className="font-medium">{file.title}</span>
          ),
        ),
      ],
    },
    { title: "You decided", items: recap.decided.map((line) => <span>{line}</span>) },
    {
      title: "Still out",
      items: recap.out.map((line) => (
        <span className="inline-flex items-center gap-1.5">
          {/* Out on it: the job carries on after the call, like the sidebar's breathing mark. */}
          {line.kind === "working" ? <span className="size-1.5 shrink-0 rounded-full bg-accent breathe-soft" aria-hidden="true" /> : null}
          {line.text}
        </span>
      )),
    },
  ].filter((s) => s.items.length > 0);

  return (
    <section aria-label="Call recap" className="mt-6 overflow-hidden rounded-xl border border-line animate-fade-up">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <AudioLines size={15} className="shrink-0 text-accent" />
        <p className="text-[12px] font-medium tracking-[0.01em] text-fg-3">Call · {callLength(recap.seconds)}</p>
      </div>
      {sections.length ? (
        <dl className="flex flex-col gap-2.5 px-4 pb-3.5">
          {sections.map((section) => (
            <div key={section.title} className="grid gap-0.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
              <dt className="text-[12.5px] text-fg-3">{section.title}</dt>
              <dd>
                <ul className="flex flex-col gap-0.5 text-[13.5px] leading-[1.5] text-fg-2 [overflow-wrap:anywhere]">
                  {section.items.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

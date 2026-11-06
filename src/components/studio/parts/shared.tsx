import type { ReactNode } from "react";

export const fieldClass =
  "w-full rounded-lg border border-line bg-surface px-3 text-fg outline-none transition-[border-color,box-shadow] placeholder:text-fg-4 focus:border-line-strong focus:shadow-composer focus-visible:outline-none";

/** A part's heading: what it is, in one line, with room for an action. */
export function PartHead({ title, hint, children }: { title: string; hint: string; children?: ReactNode }) {
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h2 className="font-display text-[22px] leading-tight tracking-[-0.01em] text-fg">{title}</h2>
        <p className="mt-0.5 text-[13px] leading-snug text-fg-3">{hint}</p>
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </header>
  );
}

export function Unread({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[13.5px] text-fg-3">{children}</p>;
}

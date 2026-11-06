import { foldDiff, lineDiff } from "@/lib/line-diff";

// What differs between two versions of a text, line by line. `gone` and `added` say what each
// side is, in the place it's used ("Replaced", "Only in this version").

export function LineDiff({ before, after, gone, added, className = "" }: { before: string; after: string; gone: string; added: string; className?: string }) {
  const lines = foldDiff(lineDiff(before, after));
  if (!lines.some((l) => l.kind === "gone" || l.kind === "new")) return <p className={`text-[12.5px] text-fg-3 ${className}`}>Nothing differs.</p>;
  return (
    <div className={className}>
      <div className="max-h-72 overflow-y-auto rounded-lg border border-line font-mono text-[12px] leading-[1.55]">
        {lines.map((line, i) =>
          line.kind === "fold" ? (
            <p key={i} className="bg-subtle/60 px-2.5 py-0.5 text-fg-4">
              {line.count} unchanged {line.count === 1 ? "line" : "lines"}
            </p>
          ) : (
            <p
              key={i}
              className={`min-h-[1.55em] whitespace-pre-wrap px-2.5 [overflow-wrap:anywhere] ${
                line.kind === "gone" ? "bg-danger-soft text-danger" : line.kind === "new" ? "bg-success/10 text-success" : "text-fg-3"
              }`}
            >
              <span className="sr-only">{line.kind === "gone" ? `${gone}: ` : line.kind === "new" ? `${added}: ` : ""}</span>
              {line.text}
            </p>
          ),
        )}
      </div>
      <p aria-hidden="true" className="mt-1 flex gap-3 text-[11.5px] text-fg-4">
        <span className="text-danger">{gone}</span>
        <span className="text-success">{added}</span>
      </p>
    </div>
  );
}

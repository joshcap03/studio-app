import {
  ArrowUpRight,
  Database,
  File,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Link2,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import type { Artifact, ArtifactKind } from "@/lib/types";

// Rendered only from structured artifact metadata sent by the backend. New kinds need one
// entry here; unknown kinds fall back to a generic file.

const KINDS: Record<ArtifactKind, { icon: LucideIcon; tint: string; label: string }> = {
  spreadsheet: { icon: FileSpreadsheet, tint: "text-[#2f7a4c] bg-[#2f7a4c]/10", label: "Spreadsheet" },
  document: { icon: FileText, tint: "text-[#3a64a8] bg-[#3a64a8]/10", label: "Document" },
  presentation: { icon: Presentation, tint: "text-[#b0702a] bg-[#b0702a]/10", label: "Presentation" },
  pdf: { icon: FileText, tint: "text-[#b0412f] bg-[#b0412f]/10", label: "PDF" },
  image: { icon: ImageIcon, tint: "text-[#7a5aa6] bg-[#7a5aa6]/10", label: "Image" },
  data: { icon: Database, tint: "text-fg-2 bg-subtle", label: "Data" },
  file: { icon: File, tint: "text-fg-2 bg-subtle", label: "File" },
  link: { icon: Link2, tint: "text-fg-2 bg-subtle", label: "Link" },
};

export function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const kind = KINDS[artifact.kind] ?? KINDS.file;
  const Icon = kind.icon;
  const meta = [artifact.source ?? kind.label, artifact.description].filter(Boolean).join(" · ");

  const body = (
    <>
      <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${kind.tint}`}>
        <Icon size={18} strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-fg">{artifact.title}</span>
        <span className="block truncate text-[12.5px] text-fg-3">{meta}</span>
      </span>
      {artifact.url ? (
        <span className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[13px] font-medium text-fg-2 transition-colors group-hover/artifact:text-fg">
          Open
          <ArrowUpRight
            size={14}
            className="transition-transform duration-200 group-hover/artifact:translate-x-px group-hover/artifact:-translate-y-px"
          />
        </span>
      ) : null}
    </>
  );

  const className =
    "group/artifact flex w-full max-w-[420px] items-center gap-3 rounded-xl border border-line bg-surface py-2.5 pr-2 pl-2.5 text-left animate-fade-up";

  return artifact.url ? (
    <a
      href={artifact.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`${className} transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-composer`}
      aria-label={`Open ${artifact.title} (${kind.label})`}
    >
      {body}
    </a>
  ) : (
    <div className={className}>{body}</div>
  );
}

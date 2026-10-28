"use client";

import { AlertCircle, FileSpreadsheet, FileText, Image as ImageIcon, X, type LucideIcon } from "lucide-react";
import type { Attachment } from "@/lib/types";

// File chips: on a sent message (download links) and in the composer (uploading, ready, or
// failed, with a remove button).

export function iconFor(name: string, mimeType?: string): LucideIcon {
  if (mimeType?.startsWith("image/") || /\.(png|jpe?g)$/i.test(name)) return ImageIcon;
  if (/\.(csv|json|xlsx?)$/i.test(name) || /spreadsheet|excel/.test(mimeType ?? "")) return FileSpreadsheet;
  return FileText;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Files on a sent message. Each downloads the member's own copy. */
export function AttachmentList({ attachments, align = "end" }: { attachments: Attachment[]; align?: "start" | "end" }) {
  return (
    <ul className={`flex flex-wrap gap-1.5 ${align === "end" ? "justify-end" : ""}`} aria-label="Attached files">
      {attachments.map((a) => {
        const Icon = iconFor(a.name, a.mimeType);
        return (
          <li key={a.id}>
            <a
              href={`/api/attachments/${a.id}`}
              download={a.name}
              className="inline-flex h-9 max-w-[16rem] items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-fg transition-colors hover:border-line-strong"
            >
              <Icon size={15} className="shrink-0 text-fg-3" />
              <span className="truncate">{a.name}</span>
              <span className="shrink-0 text-[12px] text-fg-3">{formatSize(a.size)}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export interface PendingFile {
  key: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "error";
  attachment?: Attachment;
  error?: string;
}

/** Files waiting in the composer. */
export function PendingFiles({ files, onRemove }: { files: PendingFile[]; onRemove: (key: string) => void }) {
  if (files.length === 0) return null;
  return (
    <ul className="flex w-full flex-wrap gap-1.5 pb-1.5" aria-label="Files to send">
      {files.map((f) => {
        const Icon = f.status === "error" ? AlertCircle : iconFor(f.name);
        return (
          <li
            key={f.key}
            title={f.error}
            className={`inline-flex h-9 max-w-[16rem] items-center gap-2 rounded-lg border pr-1 pl-2.5 text-[13px] ${
              f.status === "error" ? "border-danger/40 bg-danger-soft text-fg" : "border-line bg-subtle text-fg"
            }`}
          >
            {f.status === "uploading" ? (
              <span className="spinner size-3.5 shrink-0" aria-label="Uploading" />
            ) : (
              <Icon size={15} className={`shrink-0 ${f.status === "error" ? "text-danger" : "text-fg-3"}`} />
            )}
            <span className="truncate">{f.name}</span>
            <span className="shrink-0 text-[12px] text-fg-3">{f.status === "error" ? "Didn't upload" : formatSize(f.size)}</span>
            <button
              type="button"
              onClick={() => onRemove(f.key)}
              aria-label={`Remove ${f.name}`}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg"
            >
              <X size={13} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

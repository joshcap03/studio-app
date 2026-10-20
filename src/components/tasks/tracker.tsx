"use client";

import { ExternalLink, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useInlineEdit } from "@/components/ui/inline-edit";
import { api } from "@/lib/client/api";
import type { AgentRecord } from "@/lib/tasks/types";
import { errorText, formatDay, iconButton } from "./shared";

// The agent's tracker (job applications, contacts, posts): on a task's page for that task's rows,
// and in the Library one page per collection.

const card = "rounded-2xl border border-line bg-surface p-4";

export function collectionName(collection: string): string {
  const words = collection.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Tracker rows grouped by collection, with each row's status editable and a remove button. */
export function Tracker({
  records,
  onChange,
  onError,
  empty,
}: {
  records: AgentRecord[] | null;
  onChange: (records: AgentRecord[]) => void;
  onError: (message: string | null) => void;
  /** What an empty tracker says. */
  empty: string;
}) {
  if (!records || records.length === 0) {
    return (
      <section className={card} aria-labelledby="tracker-heading">
        <h2 id="tracker-heading" className="text-[13.5px] font-medium text-fg">
          Tracker
        </h2>
        <p className="mt-2 text-[13px] text-fg-3">{records ? empty : "Loading…"}</p>
      </section>
    );
  }

  const groups = new Map<string, AgentRecord[]>();
  for (const r of records) groups.set(r.collection, [...(groups.get(r.collection) ?? []), r]);

  async function setStatus(record: AgentRecord, status: string | null) {
    onError(null);
    try {
      const { record: saved } = await api.updateRecord(record.id, { status });
      onChange(records!.map((r) => (r.id === saved.id ? saved : r)));
    } catch (error) {
      onError(errorText(error));
    }
  }

  async function remove(record: AgentRecord) {
    if (!window.confirm(`Remove "${record.title || record.key}" from the tracker?`)) return;
    onError(null);
    try {
      await api.deleteRecord(record.id);
      onChange(records!.filter((r) => r.id !== record.id));
    } catch (error) {
      onError(errorText(error));
    }
  }

  return (
    <section className={card} aria-labelledby="tracker-heading">
      <h2 id="tracker-heading" className="text-[13.5px] font-medium text-fg">
        Tracker
      </h2>
      {[...groups].map(([collection, rows]) => (
        <div key={collection} className="mt-3">
          <h3 className="text-[12.5px] font-medium text-fg-3">
            {collectionName(collection)} <span className="font-normal text-fg-4">· {rows.length}</span>
          </h3>
          <div className="-mx-1 mt-1">
            <TrackerTable rows={rows} onSave={setStatus} onRemove={remove} />
          </div>
        </div>
      ))}
    </section>
  );
}

/** A few short fields of a row (e.g. "location: Remote · score: 4"), for its details line. */
export function recordDetails(record: AgentRecord, max = 3): string {
  return Object.entries(record.fields)
    .filter(([, v]) => (typeof v === "string" && v.trim() && v.length <= 40) || typeof v === "number")
    .slice(0, max)
    .map(([k, v]) => `${k.replace(/[-_]+/g, " ")}: ${String(v).trim()}`)
    .join(" · ");
}

/** Rows as a table: title (linked when there's a url), editable status, last change, remove. */
export function TrackerTable({
  rows,
  onSave,
  onRemove,
  details = false,
}: {
  rows: AgentRecord[];
  onSave: (record: AgentRecord, status: string | null) => void;
  onRemove: (record: AgentRecord) => void;
  /** Show a line of each row's short fields under its title. */
  details?: boolean;
}) {
  return (
    <table className="w-full text-left text-[13px]">
      <thead className="sr-only">
        <tr>
          <th>Title</th>
          <th>Status</th>
          <th className="max-sm:hidden">Updated</th>
          <th>Remove</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {rows.map((r) => {
          const extra = details ? recordDetails(r) : "";
          return (
            <tr key={r.id}>
              <td className={`w-full max-w-0 px-1 ${extra ? "py-2" : "py-1.5"}`}>
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="group/link inline-flex max-w-full items-center gap-1 text-fg hover:underline">
                    <span className="truncate">{r.title || r.key}</span>
                    <ExternalLink size={12} className="shrink-0 text-fg-4" aria-hidden="true" />
                  </a>
                ) : (
                  <span className="block truncate text-fg">{r.title || r.key}</span>
                )}
                {extra ? <span className="mt-0.5 block truncate text-[12px] text-fg-3">{extra}</span> : null}
              </td>
              <td className="px-1 py-1.5">
                <RecordStatus record={r} onSave={(status) => onSave(r, status)} />
              </td>
              <td className="px-1 py-1.5 text-right text-[12.5px] whitespace-nowrap text-fg-3 max-sm:hidden">{formatDay(r.updatedAt)}</td>
              <td className="px-0 py-1.5">
                <button type="button" aria-label={`Remove ${r.title || r.key}`} onClick={() => onRemove(r)} className={`${iconButton} hover:text-danger`}>
                  <Trash2 size={14} />
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function RecordStatus({ record, onSave }: { record: AgentRecord; onSave: (status: string | null) => void }) {
  const [value, setValue] = useState(record.status ?? "");
  useEffect(() => setValue(record.status ?? ""), [record.status]);

  const edit = useInlineEdit({
    commit: () => {
      const next = value.trim() || null;
      if (next !== record.status) onSave(next);
    },
    revert: () => setValue(record.status ?? ""),
  });

  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      {...edit}
      maxLength={40}
      placeholder="No status"
      aria-label={`Status of ${record.title || record.key}`}
      className="h-8 w-[6.5rem] rounded-lg border border-transparent bg-subtle px-2 text-[12.5px] sm:w-[9.5rem] text-fg-2 outline-none transition-colors placeholder:text-fg-4 hover:border-line focus:border-line-strong focus:bg-surface focus-visible:outline-none"
    />
  );
}

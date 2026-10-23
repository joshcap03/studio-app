"use client";

import { ChevronDown, ExternalLink, Trash2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useInlineEdit } from "@/components/ui/inline-edit";
import { api } from "@/lib/client/api";
import { detailColumns, detailLine, fieldLabel, shownFields } from "@/lib/tasks/fields";
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
  /** Show a line of each row's short fields under its title, the same ones for every row, and open a row to read them all. */
  details?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const columns = useMemo(() => (details ? detailColumns(rows) : []), [details, rows]);

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
      {rows.map((r) => {
        const all = details ? shownFields(r) : [];
        const line = details ? detailLine(r, columns) : "";
        const expanded = open === r.id;
        const name = r.title || r.key;
        return (
          <tbody key={r.id} className="border-line not-first:border-t">
            <tr>
              <td className={`w-full max-w-0 px-1 ${details ? "py-2" : "py-1.5"}`}>
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="group/link inline-flex max-w-full items-center gap-1 text-fg hover:underline">
                    <span className="truncate">{name}</span>
                    <ExternalLink size={12} className="shrink-0 text-fg-4" aria-hidden="true" />
                  </a>
                ) : (
                  <span className="block truncate text-fg">{name}</span>
                )}
                {all.length > 0 ? (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={`record-${r.id}`}
                    aria-label={`${expanded ? "Hide" : "Show"} details of ${name}`}
                    onClick={() => setOpen(expanded ? null : r.id)}
                    className="mt-0.5 flex max-w-full items-center gap-1 text-left text-[12px] text-fg-3 transition-colors hover:text-fg-2"
                  >
                    <span className="truncate">{line || "Details"}</span>
                    <ChevronDown size={12} aria-hidden="true" className={`shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
                  </button>
                ) : null}
              </td>
              <td className="px-1 py-1.5 align-top">
                <RecordStatus record={r} onSave={(status) => onSave(r, status)} />
              </td>
              <td className={`px-1 text-right text-[12.5px] whitespace-nowrap text-fg-3 max-sm:hidden ${details ? "py-3.5 align-top" : "py-1.5"}`}>
                {formatDay(r.updatedAt)}
              </td>
              <td className="px-0 py-1.5 align-top">
                <button type="button" aria-label={`Remove ${name}`} onClick={() => onRemove(r)} className={`${iconButton} hover:text-danger`}>
                  <Trash2 size={14} />
                </button>
              </td>
            </tr>
            {expanded ? (
              <tr id={`record-${r.id}`}>
                <td colSpan={4} className="px-1 pb-3">
                  <dl className="grid animate-fade-in grid-cols-[minmax(0,7rem)_1fr] gap-x-4 gap-y-1.5 rounded-xl bg-subtle px-3 py-2.5 text-[12.5px]">
                    {all.map(([key, text]) => (
                      <Fragment key={key}>
                        <dt className="truncate text-fg-3 first-letter:uppercase">{fieldLabel(key)}</dt>
                        <dd className="min-w-0 break-words text-fg-2">
                          {/^https:\/\/\S+$/.test(text) ? (
                            <a href={text} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-fg hover:underline">
                              {hostOf(text)}
                              <ExternalLink size={11} className="shrink-0 text-fg-4" aria-hidden="true" />
                            </a>
                          ) : (
                            text
                          )}
                        </dd>
                      </Fragment>
                    ))}
                  </dl>
                </td>
              </tr>
            ) : null}
          </tbody>
        );
      })}
    </table>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
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

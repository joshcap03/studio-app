"use client";

import { ChevronDown, ExternalLink, Trash2 } from "lucide-react";
import { Fragment, useMemo, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { detailCells, detailColumns, fieldLabel, shownFields } from "@/lib/tasks/fields";
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

/** Status tones: a dot beside each status, a different one for each of a collection's statuses. */
const TONES = ["bg-chart-2", "bg-chart-1", "bg-chart-3", "bg-chart-4", "bg-fg-3"];

/** Each status's tone, by its place in the collection's statuses A to Z, so the same rows keep their colors. */
function tonesOf(statuses: string[]): Map<string, string> {
  return new Map([...statuses].sort((a, b) => a.localeCompare(b)).map((s, i) => [s, TONES[i % TONES.length]]));
}

/** The statuses a collection's rows use, most used first. */
function statusesOf(rows: AgentRecord[]): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) if (r.status) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
}

const INTERACTIVE = "a, button, input, select, textarea";

/**
 * Rows as a table: title (linked when there's a url), status, last change, remove. With details,
 * the collection's short fields are columns (a line under the title where the table is narrow) and
 * a row opens to read all of them. Inside an `@container`.
 */
export function TrackerTable({
  rows,
  statuses,
  onSave,
  onRemove,
  details = false,
}: {
  rows: AgentRecord[];
  /** The statuses to offer; the rows' own when not given. */
  statuses?: string[];
  onSave: (record: AgentRecord, status: string | null) => void;
  onRemove: (record: AgentRecord) => void;
  /** Show the collection's short fields as columns, the same ones for every row, and open a row to read them all. */
  details?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const columns = useMemo(() => (details ? detailColumns(rows) : []), [details, rows]);
  const options = useMemo(() => statuses ?? statusesOf(rows), [statuses, rows]);
  const tones = useMemo(() => tonesOf(options), [options]);
  // A date that's the same on every row says nothing.
  const dated = useMemo(() => new Set(rows.map((r) => formatDay(r.updatedAt))).size > 1 || !details, [rows, details]);
  const span = 3 + columns.length + (dated ? 1 : 0);
  const cell = details ? "px-3 py-2.5 first:pl-4 last:pr-2" : "px-1 py-1.5";

  return (
    <table className="w-full text-left text-[13px]">
      <thead className={details ? "border-b border-line bg-subtle text-[12px] text-fg-3" : "sr-only"}>
        <tr>
          <th className={`${cell} font-medium`}>{details ? "Name" : "Title"}</th>
          {columns.map((key) => (
            <th key={key} className={`${cell} font-medium whitespace-nowrap first-letter:uppercase @max-3xl:hidden`}>
              {fieldLabel(key)}
            </th>
          ))}
          <th className={`${cell} font-medium`}>Status</th>
          {dated ? <th className={`${cell} font-medium ${details ? "@max-md:hidden" : "text-right max-sm:hidden"}`}>Updated</th> : null}
          <th className={cell}>
            <span className="sr-only">Remove</span>
          </th>
        </tr>
      </thead>
      {rows.map((r) => {
        const all = details ? shownFields(r) : [];
        const cells = details ? detailCells(r, columns) : [];
        const line = cells.filter(Boolean).join(" · ");
        // A row opens to its fields and its remove button.
        const opens = details;
        const expanded = open === r.id;
        const name = r.title || r.key;
        const toggle = () => setOpen(expanded ? null : r.id);
        return (
          <tbody key={r.id} className="border-line not-first-of-type:border-t">
            <tr
              onClick={
                opens
                  ? (e) => {
                      if (!(e.target as HTMLElement).closest(INTERACTIVE)) toggle();
                    }
                  : undefined
              }
              className={`group/row ${details ? `transition-colors ${expanded ? "bg-hover" : "hover:bg-hover"} ${opens ? "cursor-pointer" : ""}` : ""}`}
            >
              <td className={`${cell} w-full max-w-0`}>
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 text-fg hover:underline">
                    <span className={expanded ? "break-words" : "truncate"}>{name}</span>
                    <ExternalLink size={12} className="shrink-0 text-fg-4" aria-hidden="true" />
                  </a>
                ) : (
                  <span className={`block text-fg ${expanded ? "break-words" : "truncate"}`}>{name}</span>
                )}
                {line ? <span className="mt-0.5 block truncate text-[12px] text-fg-3 @3xl:hidden">{line}</span> : null}
              </td>
              {cells.map((text, i) => (
                <td key={columns[i]} className={`${cell} text-fg-2 @max-3xl:hidden`}>
                  {text ? <span className="block max-w-[12rem] truncate">{text}</span> : <span className="text-fg-4">–</span>}
                </td>
              ))}
              <td className={`${cell} whitespace-nowrap`}>
                <RecordStatus record={r} options={options} tone={r.status ? tones.get(r.status) : undefined} onSave={(status) => onSave(r, status)} />
              </td>
              {dated ? (
                <td className={`${cell} text-[12.5px] whitespace-nowrap text-fg-3 ${details ? "@max-md:hidden" : "text-right max-sm:hidden"}`}>
                  {formatDay(r.updatedAt)}
                </td>
              ) : null}
              <td className={`${cell} ${details ? "py-1.5" : ""} !px-0`}>
                <div className="flex items-center justify-end">
                  {details ? (
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={`record-${r.id}`}
                      aria-label={`${expanded ? "Hide" : "Show"} details of ${name}`}
                      onClick={toggle}
                      className={iconButton}
                    >
                      <ChevronDown size={14} aria-hidden="true" className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
                    </button>
                  ) : (
                    <button type="button" aria-label={`Remove ${name}`} onClick={() => onRemove(r)} className={`${iconButton} hover:text-danger`}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </td>
            </tr>
            {expanded ? (
              <tr id={`record-${r.id}`} className="bg-hover">
                <td colSpan={span} className="px-4 pt-0.5 pb-3.5">
                  <div className="animate-fade-in rounded-xl border border-line bg-surface text-[12.5px]">
                    {all.length > 0 ? (
                      <dl className="grid grid-cols-[minmax(0,8rem)_1fr] gap-x-4 gap-y-1.5 border-b border-line px-3.5 py-3">
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
                    ) : null}
                    <div className="flex items-center justify-between gap-3 py-1 pr-1 pl-3.5">
                      <span className="text-fg-3">Updated {formatDay(r.updatedAt).replace(/^(Today|Yesterday)$/, (day) => day.toLowerCase())}</span>
                      <button
                        type="button"
                        onClick={() => onRemove(r)}
                        className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-fg-3 transition-colors hover:bg-danger-soft hover:text-danger"
                      >
                        <Trash2 size={13} aria-hidden="true" />
                        Remove
                      </button>
                    </div>
                  </div>
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

/** Picks "a new status" in the status menu. */
const NEW_STATUS = "__new_status__";

/** A row's status as a pill: pick one the collection uses, none, or type a new one. */
function RecordStatus({
  record,
  options,
  tone,
  onSave,
}: {
  record: AgentRecord;
  options: string[];
  /** The dot's color class. */
  tone?: string;
  onSave: (status: string | null) => void;
}) {
  const [typing, setTyping] = useState(false);
  const current = record.status ?? "";
  const choices = current && !options.includes(current) ? [current, ...options] : options;
  const label = `Status of ${record.title || record.key}`;

  if (typing) {
    return (
      <NewStatus
        label={label}
        onDone={(next) => {
          setTyping(false);
          if (next && next !== record.status) onSave(next);
        }}
      />
    );
  }

  return (
    <span className="relative inline-flex">
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute top-1/2 left-2.5 size-1.5 -translate-y-1/2 rounded-full ${current ? (tone ?? TONES[TONES.length - 1]) : "border border-fg-4"}`}
      />
      <select
        value={current}
        onChange={(e) => {
          const next = e.target.value;
          if (next === NEW_STATUS) setTyping(true);
          else if (next !== current) onSave(next || null);
        }}
        aria-label={label}
        className={`h-7 max-w-[9rem] cursor-pointer @max-md:max-w-[7.5rem] appearance-none truncate rounded-full border border-line bg-surface pr-6 pl-6 text-[12.5px] outline-none transition-colors hover:border-line-strong hover:bg-hover focus-visible:border-line-strong focus-visible:outline-none ${current ? "text-fg-2" : "text-fg-4"}`}
      >
        {choices.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
        <option value="">No status</option>
        <option value={NEW_STATUS}>New status…</option>
      </select>
      <ChevronDown size={12} aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-fg-4" />
    </span>
  );
}

/** Typing a status the collection doesn't use yet: Enter or leaving saves it, Escape doesn't. */
function NewStatus({ label, onDone }: { label: string; onDone: (status: string | null) => void }) {
  const [value, setValue] = useState("");
  const done = useRef(false);
  const finish = (status: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(status);
  };
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(value.trim() || null);
        if (e.key === "Escape") finish(null);
      }}
      maxLength={40}
      placeholder="New status"
      aria-label={label}
      className="h-7 w-[9rem] rounded-full border border-line-strong bg-surface px-3 text-[12.5px] text-fg outline-none placeholder:text-fg-4 focus-visible:outline-none"
    />
  );
}

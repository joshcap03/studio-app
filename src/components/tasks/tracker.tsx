"use client";

import { ChevronDown, ExternalLink, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
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

/** Status tones: a dot beside each status, a different one for each of a collection's statuses. */
const TONES = ["bg-chart-2", "bg-chart-1", "bg-chart-3", "bg-chart-4", "bg-fg-3"];

/** Each status's tone, by its place in the collection's statuses A to Z, so the same rows keep their colors. */
export function tonesOf(statuses: string[]): Map<string, string> {
  return new Map([...statuses].sort((a, b) => a.localeCompare(b)).map((s, i) => [s, TONES[i % TONES.length]]));
}

/** The statuses a collection's rows use, most used first. */
export function statusesOf(rows: AgentRecord[]): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) if (r.status) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
}

/** Rows as a table: title (linked when there's a url), status, last change, remove. */
export function TrackerTable({
  rows,
  onSave,
  onRemove,
}: {
  rows: AgentRecord[];
  onSave: (record: AgentRecord, status: string | null) => void;
  onRemove: (record: AgentRecord) => void;
}) {
  const options = useMemo(() => statusesOf(rows), [rows]);
  const tones = useMemo(() => tonesOf(options), [options]);

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
      <tbody>
        {rows.map((r) => {
          const name = r.title || r.key;
          return (
            <tr key={r.id} className="border-line not-first:border-t">
              <td className="w-full max-w-0 px-1 py-1.5">
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 text-fg hover:underline">
                    <span className="truncate">{name}</span>
                    <ExternalLink size={12} className="shrink-0 text-fg-4" aria-hidden="true" />
                  </a>
                ) : (
                  <span className="block truncate text-fg">{name}</span>
                )}
              </td>
              <td className="px-1 py-1.5 whitespace-nowrap">
                <RecordStatus record={r} options={options} tone={r.status ? tones.get(r.status) : undefined} onSave={(status) => onSave(r, status)} />
              </td>
              <td className="px-1 py-1.5 text-right text-[12.5px] whitespace-nowrap text-fg-3 max-sm:hidden">{formatDay(r.updatedAt)}</td>
              <td className="px-0 py-1.5">
                <button type="button" aria-label={`Remove ${name}`} onClick={() => onRemove(r)} className={`${iconButton} hover:text-danger`}>
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

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Picks "a new status" in the status menu. */
const NEW_STATUS = "__new_status__";

/** A row's status as a pill: pick one the collection uses, none, or type a new one. */
export function RecordStatus({
  record,
  options,
  tone,
  cell,
  tabIndex,
  onSave,
}: {
  record: AgentRecord;
  options: string[];
  /** The dot's color class. */
  tone?: string;
  /** Its place in a sheet, for moving between cells with the keyboard. */
  cell?: string;
  tabIndex?: number;
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
        data-cell={cell}
        tabIndex={tabIndex}
        className={`h-7 max-w-[9rem] cursor-pointer appearance-none truncate rounded-full border border-line bg-surface pr-6 pl-6 text-[12.5px] outline-none transition-colors hover:border-line-strong hover:bg-hover focus-visible:border-line-strong focus-visible:outline-none ${current ? "text-fg-2" : "text-fg-4"}`}
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
        e.stopPropagation();
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

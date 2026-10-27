"use client";

import { ArrowLeft, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "@/components/tasks/shared";
import { collectionName } from "@/components/tasks/tracker";
import { cellText } from "@/lib/tasks/fields";
import { type RecordChange, TrackerSheet } from "./tracker-sheet";
import { api } from "@/lib/client/api";
import type { AgentRecord } from "@/lib/tasks/types";

// One tracker from the Library (e.g. job applications) as a sheet: every row, newest first,
// narrowed by status or a search, every cell editable, and rows and columns the member adds.
// Rows are the agent's and the member's alike.

interface Props {
  collection: string;
  onBack: () => void;
}

const chip =
  "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] transition-colors aria-pressed:border-line-strong aria-pressed:bg-press aria-pressed:text-fg";

/** A search box shows up once a tracker is longer than this. */
const SEARCH_FROM = 8;

export function TrackerPage({ collection, onBack }: Props) {
  const [records, setRecords] = useState<AgentRecord[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Rows added here stay in view whatever the filter or search, so a new row doesn't vanish.
  const [added, setAdded] = useState<Set<string>>(() => new Set());
  const saving = useRef(new Map<string, number>());

  useEffect(() => {
    const controller = new AbortController();
    api
      .listRecords(controller.signal, collection)
      .then(({ records }) => setRecords(records))
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [collection]);

  const statuses = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of records ?? []) if (r.status) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [records]);

  // A status filter whose last row changed away shows everything again.
  const activeStatus = status && statuses.some(([s]) => s === status) ? status : null;
  const needle = query.trim().toLowerCase();
  const sorted = useMemo(() => [...(records ?? [])].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)), [records]);
  const shown = sorted.filter(
    (r) =>
      added.has(r.id) ||
      ((!activeStatus || r.status === activeStatus) &&
        (!needle ||
          `${r.title} ${r.key} ${r.url ?? ""} ${Object.values(r.fields)
            .map((v) => cellText(v) ?? "")
            .join(" ")}`
            .toLowerCase()
            .includes(needle))),
  );

  const put = (record: AgentRecord) => setRecords((all) => (all ?? []).map((r) => (r.id === record.id ? record : r)));

  /** Shows the change at once and saves it; if it doesn't save, the cell goes back. */
  async function save(record: AgentRecord, change: RecordChange & { status?: string | null }) {
    setNotice(null);
    put({ ...record, ...change });
    // Only the latest save of a row decides what it shows, whichever answer comes back last.
    const turn = (saving.current.get(record.id) ?? 0) + 1;
    saving.current.set(record.id, turn);
    try {
      const { record: saved } = await api.updateRecord(record.id, change);
      if (saving.current.get(record.id) === turn) put(saved);
    } catch (error) {
      if (saving.current.get(record.id) === turn) put(record);
      setNotice(errorText(error));
    }
  }

  async function add(title: string): Promise<boolean> {
    setNotice(null);
    try {
      const { record } = await api.createRecord({ collection, title, ...(activeStatus ? { status: activeStatus } : {}) });
      setAdded((ids) => new Set(ids).add(record.id));
      setRecords((all) => [record, ...(all ?? [])]);
      return true;
    } catch (error) {
      setNotice(errorText(error));
      return false;
    }
  }

  async function remove(record: AgentRecord) {
    if (!window.confirm(`Remove "${record.title || record.key}" from the tracker?`)) return;
    setNotice(null);
    try {
      await api.deleteRecord(record.id);
      setRecords((all) => (all ?? []).filter((r) => r.id !== record.id));
    } catch (error) {
      setNotice(errorText(error));
    }
  }

  const name = collectionName(collection);

  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-4 md:px-8">
      <div className="mx-auto w-full max-w-[64rem] pt-6 pb-[max(24px,env(safe-area-inset-bottom))] md:pt-[6vh]">
        <a
          href="/library"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            onBack();
          }}
          className="inline-flex items-center gap-1.5 text-[13px] text-fg-3 transition-colors hover:text-fg"
        >
          <ArrowLeft size={14} />
          Library
        </a>
        <div className="mt-3 animate-fade-up">
          <h1 className="font-display text-[28px] leading-tight tracking-[-0.015em] text-fg md:text-[32px]">{name}</h1>
          {records ? (
            <p className="mt-1 text-[14px] text-fg-3">
              {records.length} {records.length === 1 ? "row" : "rows"}. I add to this as I work. Click any cell to change it.
            </p>
          ) : null}
        </div>

        {notice ? (
          <p role="alert" className="mt-4 text-[13px] text-danger">
            {notice}
          </p>
        ) : null}

        {failed ? (
          <p role="alert" className="mt-8 text-[13.5px] text-danger">
            Couldn&apos;t load this tracker. Check your connection and reload the page.
          </p>
        ) : records === null ? (
          <div className="mt-10 flex justify-center" aria-busy="true">
            <span className="spinner animate-fade-in [animation-delay:200ms]" aria-label="Loading the tracker" />
          </div>
        ) : records.length === 0 ? (
          <p className="mt-8 rounded-xl border border-dashed border-line px-4 py-8 text-center text-[13.5px] text-fg-3">Nothing in this tracker.</p>
        ) : (
          <div className="mt-6 animate-fade-up [animation-delay:60ms]">
            <div className="flex flex-wrap items-center gap-2">
              {statuses.length > 1 ? (
                <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1.5">
                  <button type="button" aria-pressed={!activeStatus} onClick={() => setStatus(null)} className={`${chip} border-line text-fg-2 hover:bg-hover`}>
                    All <span className="text-fg-4">{records.length}</span>
                  </button>
                  {statuses.map(([s, count]) => (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={activeStatus === s}
                      onClick={() => setStatus(activeStatus === s ? null : s)}
                      className={`${chip} border-line text-fg-2 hover:bg-hover`}
                    >
                      {s} <span className="text-fg-4">{count}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {records.length > SEARCH_FROM ? (
                <div className="relative ml-auto w-full sm:w-56">
                  <Search size={14} strokeWidth={1.75} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-3" />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setQuery("");
                    }}
                    placeholder={`Search ${name.toLowerCase()}`}
                    aria-label={`Search ${name}`}
                    className="h-8 w-full rounded-lg border border-line bg-surface pr-8 pl-8 text-[13px] text-fg outline-none placeholder:text-fg-4 focus:border-line-strong focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
                  />
                  {query ? (
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      aria-label="Clear search"
                      className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-3 hover:bg-hover hover:text-fg"
                    >
                      <X size={13} />
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="@container mt-3 overflow-hidden rounded-2xl border border-line bg-surface">
              <div className="scroll-quiet overflow-x-auto">
                <TrackerSheet
                  rows={shown}
                  all={sorted}
                  statuses={statuses.map(([s]) => s)}
                  onChange={save}
                  onStatus={(record, status) => save(record, { status })}
                  onRemove={remove}
                  onAdd={add}
                />
              </div>
              {shown.length === 0 ? <p className="py-4 text-center text-[13px] text-fg-3">Nothing matches.</p> : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

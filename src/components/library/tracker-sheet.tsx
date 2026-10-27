"use client";

import { ExternalLink, Plus, Trash2 } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { formatDay, iconButton } from "@/components/tasks/shared";
import { hostOf, RecordStatus, tonesOf } from "@/components/tasks/tracker";
import { cellText, fieldKey, fieldLabel, sheetColumns } from "@/lib/tasks/fields";
import type { AgentRecord } from "@/lib/tasks/types";

// A tracker as a sheet: every field a column, every cell changed in place. Click a cell, or move
// to it with the arrow keys and press Enter or just type; Enter saves and moves down, Tab saves and
// moves right, Escape puts it back. Rows the member adds and columns they name sit beside the
// agent's, which keeps adding to the same sheet.

export interface RecordChange {
  title?: string;
  url?: string | null;
  fields?: Record<string, unknown>;
}

type Column =
  | { kind: "title" }
  | { kind: "status" }
  | { kind: "field"; key: string; long: boolean }
  | { kind: "url" }
  | { kind: "updated" };

/** A field that's just a link shows its site, with the link beside it. */
const LINK = /^https:\/\/\S+$/;

type Move = "down" | "right" | "left" | "stay" | null;

const head = "border-b border-r border-line px-3 py-2 text-left text-[12px] font-medium whitespace-nowrap text-fg-3";
const body = "relative border-b border-r border-line px-3 align-top focus:outline-none focus:ring-2 focus:ring-ring focus:ring-inset";
const sticky = "sticky left-0 z-10";

function widthOf(column: Column): string {
  switch (column.kind) {
    case "title":
      return "w-[15rem] @max-md:w-[10rem]";
    case "status":
      return "w-[9rem]";
    case "field":
      return column.long ? "w-[18rem]" : "w-[10rem]";
    case "url":
      return "w-[10rem]";
    case "updated":
      return "w-[5.5rem]";
  }
}

function nameOf(column: Column): string {
  switch (column.kind) {
    case "title":
      return "Name";
    case "status":
      return "Status";
    case "field":
      return fieldLabel(column.key);
    case "url":
      return "Link";
    case "updated":
      return "Updated";
  }
}

/** A cell's text, "" when empty, or null where the cell can't be typed in. */
function textOf(record: AgentRecord, column: Column): string | null {
  switch (column.kind) {
    case "title":
      return record.title;
    case "url":
      return record.url ?? "";
    case "field":
      return cellText(record.fields[column.key]);
    default:
      return null;
  }
}

/** What typing `text` into a cell changes, or null when it changes nothing. */
function changeOf(record: AgentRecord, column: Column, text: string): RecordChange | null {
  const value = text.trim();
  if (column.kind === "title") return value === record.title ? null : { title: value };
  if (column.kind === "url") {
    const url = value && !/^https?:\/\//i.test(value) ? `https://${value}` : value;
    return url === (record.url ?? "") ? null : { url: url || null };
  }
  if (column.kind !== "field") return null;
  const previous = record.fields[column.key];
  if (value === (cellText(previous) ?? "")) return null;
  const fields = { ...record.fields };
  if (!value) delete fields[column.key];
  // A number stays a number when it's changed to another one.
  else fields[column.key] = typeof previous === "number" && Number.isFinite(Number(value)) ? Number(value) : value;
  return { fields };
}

export function TrackerSheet({
  rows,
  all,
  statuses,
  onChange,
  onStatus,
  onRemove,
  onAdd,
}: {
  /** The rows shown, in order. */
  rows: AgentRecord[];
  /** Every row in the collection, for its columns. */
  all: AgentRecord[];
  /** The collection's statuses, most used first. */
  statuses: string[];
  onChange: (record: AgentRecord, change: RecordChange) => void;
  onStatus: (record: AgentRecord, status: string | null) => void;
  onRemove: (record: AgentRecord) => void;
  /** Adds a row with this name; false when it couldn't. */
  onAdd: (title: string) => Promise<boolean>;
}) {
  const table = useRef<HTMLTableElement>(null);
  const [editing, setEditing] = useState<{ id: string; col: number; seed?: string } | null>(null);
  const [named, setNamed] = useState<string[]>([]);
  const [naming, setNaming] = useState(false);
  const [adding, setAdding] = useState(false);
  // The one cell Tab reaches; the arrow keys move from it to the rest.
  const [current, setCurrent] = useState("0:0");

  const tones = useMemo(() => tonesOf(statuses), [statuses]);
  // Columns keep their places while the sheet is open: one the member names, or the agent starts,
  // joins at the end, and a column doesn't jump when a cell in it is filled or emptied.
  const order = useRef<string[]>([]);
  const columns = useMemo<Column[]>(() => {
    const found = sheetColumns(all);
    for (const key of [...found.map((c) => c.key), ...named]) if (!order.current.includes(key)) order.current = [...order.current, key];
    const fields = order.current.map((key) => ({ key, long: found.find((c) => c.key === key)?.long ?? false }));
    // A date that's the same on every row says nothing.
    const dated = new Set(all.map((r) => formatDay(r.updatedAt))).size > 1;
    return [
      { kind: "title" },
      { kind: "status" },
      ...fields.map((c) => ({ kind: "field" as const, ...c })),
      ...(all.some((r) => r.url) ? [{ kind: "url" as const }] : []),
      ...(dated ? [{ kind: "updated" as const }] : []),
    ];
  }, [all, named]);

  /** Focuses a cell; false when there's none there (past the last row). */
  function focusCell(row: number, col: number): boolean {
    const cell = table.current?.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`);
    cell?.focus();
    return Boolean(cell);
  }

  function startEditing(row: number, col: number, seed?: string) {
    const record = rows[row];
    if (record && textOf(record, columns[col]) !== null) setEditing({ id: record.id, col, seed });
  }

  function onKey(e: KeyboardEvent<HTMLTableElement>) {
    const target = e.target as HTMLElement;
    const at = target.dataset.cell;
    if (!at || editing) return;
    const [row, col] = at.split(":").map(Number);
    const menu = target.tagName === "SELECT";
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      focusCell(row + dr, col + dc);
    };
    if (e.key === "ArrowLeft") move(0, -1);
    else if (e.key === "ArrowRight") move(0, 1);
    else if (menu) return;
    else if (e.key === "ArrowUp") move(-1, 0);
    else if (e.key === "ArrowDown") move(1, 0);
    else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      startEditing(row, col);
    } else if ((e.key === "Backspace" || e.key === "Delete") && columns[col].kind !== "title") {
      const record = rows[row];
      const change = record && textOf(record, columns[col]) !== null ? changeOf(record, columns[col], "") : null;
      if (change) onChange(record, change);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      startEditing(row, col, e.key);
    }
  }

  function addColumn(name: string) {
    setNaming(false);
    const key = fieldKey(name);
    if (!key) return;
    const at = columns.findIndex((c) => c.kind === "field" && c.key === key);
    if (at < 0) setNamed((keys) => [...keys, key]);
    // Straight into its first cell, the way a sheet's new column fills.
    if (rows.length > 0) {
      const col = at >= 0 ? at : columns.findIndex((c) => c.kind === "url" || c.kind === "updated");
      setEditing({ id: rows[0].id, col: col >= 0 ? col : columns.length });
    }
  }

  return (
    <table
      ref={table}
      onKeyDown={onKey}
      onFocus={(e) => {
        const cell = (e.target as HTMLElement).dataset.cell;
        if (cell) setCurrent(cell);
      }}
      className="min-w-full border-separate border-spacing-0 text-[13px]"
      aria-label="Rows, each cell editable"
    >
      <thead>
        <tr className="bg-subtle">
          {columns.map((column, i) => (
            <th key={i} scope="col" className={`${head} ${i === 0 ? `${sticky} bg-subtle` : ""}`}>
              <div className={`${widthOf(column)} truncate first-letter:uppercase`}>{nameOf(column)}</div>
            </th>
          ))}
          <th scope="col" className="w-full border-b border-line px-1 py-0.5 text-left">
            {naming ? (
              <NameInput placeholder="Column name" label="New column's name" onDone={(name) => (name ? addColumn(name) : setNaming(false))} />
            ) : (
              <button type="button" onClick={() => setNaming(true)} aria-label="Add a column" title="Add a column" className={`${iconButton} size-7`}>
                <Plus size={14} />
              </button>
            )}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td className={`${sticky} border-r border-b border-line bg-surface px-3`}>
            <div className={`${widthOf(columns[0])} flex h-9 items-center`}>
              {adding ? (
                <NameInput
                  placeholder="Name"
                  label="New row's name"
                  keepOpen
                  onDone={async (name) => {
                    if (!name) setAdding(false);
                    else if (!(await onAdd(name))) setAdding(false);
                  }}
                />
              ) : (
                <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 text-fg-3 transition-colors hover:text-fg">
                  <Plus size={14} aria-hidden="true" />
                  New row
                </button>
              )}
            </div>
          </td>
          <td colSpan={columns.length} className="border-b border-line" />
        </tr>
        {rows.map((r, row) => (
          <tr key={r.id} className="group/row">
            {columns.map((column, col) => {
              const id = `${row}:${col}`;
              const place = `${col === 0 ? `${sticky} bg-surface` : ""}`;
              if (column.kind === "status") {
                return (
                  <td key={col} className={`${body} px-2 py-1`}>
                    <div className={`${widthOf(column)} flex items-center`}>
                      <RecordStatus record={r} options={statuses} tone={r.status ? tones.get(r.status) : undefined} cell={id} tabIndex={current === id ? 0 : -1} onSave={(status) => onStatus(r, status)} />
                    </div>
                  </td>
                );
              }
              const text = textOf(r, column);
              const isEditing = editing?.id === r.id && editing.col === col;
              const name = r.title || r.key;
              return (
                <td
                  key={col}
                  data-cell={id}
                  tabIndex={current === id ? 0 : -1}
                  onClick={(e: MouseEvent) => {
                    if (!(e.target as HTMLElement).closest("a, input, textarea")) startEditing(row, col);
                  }}
                  className={`${body} ${place} ${text === null ? "" : "cursor-text"}`}
                >
                  <div className={`${widthOf(column)} flex min-h-9 items-center gap-1 py-2`}>
                    {column.kind === "updated" ? (
                      <span className="text-[12.5px] whitespace-nowrap text-fg-3">{formatDay(r.updatedAt)}</span>
                    ) : column.kind === "url" && r.url ? (
                      <a href={r.url} target="_blank" rel="noopener noreferrer" tabIndex={-1} className="inline-flex min-w-0 items-center gap-1 text-fg-2 hover:text-fg hover:underline">
                        <span className="truncate">{hostOf(r.url)}</span>
                        <ExternalLink size={11} className="shrink-0 text-fg-4" aria-hidden="true" />
                      </a>
                    ) : text === null ? (
                      <span className="truncate text-fg-3">{JSON.stringify(column.kind === "field" ? r.fields[column.key] : "")}</span>
                    ) : (
                      <>
                        <span className={`truncate ${column.kind === "title" ? "text-fg" : "text-fg-2"} ${!text && column.kind === "title" ? "text-fg-4" : ""}`} title={text.length > 30 ? text : undefined}>
                          {column.kind === "title" ? text || name : LINK.test(text) ? hostOf(text) : text}
                        </span>
                        {column.kind === "field" && LINK.test(text) ? (
                          <a href={text} target="_blank" rel="noopener noreferrer" tabIndex={-1} aria-label={`Open ${hostOf(text)}`} className="shrink-0 text-fg-4 hover:text-fg">
                            <ExternalLink size={11} aria-hidden="true" />
                          </a>
                        ) : null}
                        {column.kind === "title" && r.url ? (
                          <a href={r.url} target="_blank" rel="noopener noreferrer" tabIndex={-1} aria-label={`Open ${name}`} className="shrink-0 text-fg-4 hover:text-fg">
                            <ExternalLink size={12} aria-hidden="true" />
                          </a>
                        ) : null}
                      </>
                    )}
                  </div>
                  {isEditing && text !== null ? (
                    <CellEditor
                      initial={editing.seed ?? text}
                      long={column.kind === "field" && column.long}
                      label={`${nameOf(column)} of ${name}`}
                      onDone={(value, move) => {
                        // Focus moves on before the editor goes, so the next keys land in the sheet.
                        const [dr, dc] = move === "down" ? [1, 0] : move === "right" ? [0, 1] : move === "left" ? [0, -1] : [0, 0];
                        if (move && !focusCell(row + dr, col + dc)) focusCell(row, col);
                        setEditing(null);
                        if (value !== null) {
                          const change = changeOf(r, column, value);
                          if (change) onChange(r, change);
                        }
                      }}
                    />
                  ) : null}
                </td>
              );
            })}
            <td className="border-b border-line px-1 align-middle">
              <button
                type="button"
                aria-label={`Remove ${r.title || r.key}`}
                onClick={() => onRemove(r)}
                className={`${iconButton} size-7 opacity-0 group-hover/row:opacity-100 hover:text-danger focus-visible:opacity-100 [@media(hover:none)]:opacity-100`}
              >
                <Trash2 size={13} />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A cell being typed in, laid over it; a long one grows to show all of its text. */
function CellEditor({ initial, long, label, onDone }: { initial: string; long: boolean; label: string; onDone: (text: string | null, move: Move) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const field = input.current ?? area.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);

  const finish = (text: string | null, move: Move) => {
    if (done.current) return;
    done.current = true;
    onDone(text, move);
  };
  const handlers = {
    value,
    "aria-label": label,
    onBlur: () => finish(value, null),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null, "stay");
      } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        finish(value, "down");
      } else if (e.key === "Tab") {
        e.preventDefault();
        finish(value, e.shiftKey ? "left" : "right");
      }
    },
  };

  return long ? (
    <textarea
      ref={area}
      {...handlers}
      onChange={(e) => setValue(e.target.value)}
      rows={1}
      className="absolute top-0 left-0 z-20 field-sizing-content max-h-64 min-h-full w-full min-w-[18rem] resize-none rounded-md bg-surface px-3 py-2 text-[13px] leading-5 text-fg shadow-pop ring-2 ring-ring outline-none"
    />
  ) : (
    <input
      ref={input}
      {...handlers}
      onChange={(e) => setValue(e.target.value)}
      className="absolute inset-0 z-20 w-full bg-surface px-3 text-[13px] text-fg ring-2 ring-ring outline-none ring-inset"
    />
  );
}

/** Naming a new row or column: Enter keeps it, Escape or leaving it empty doesn't. */
function NameInput({ placeholder, label, keepOpen = false, onDone }: { placeholder: string; label: string; keepOpen?: boolean; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState("");
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value.trim() || null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onDone(null);
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onDone(value.trim() || null);
          if (keepOpen) setValue("");
        }
      }}
      maxLength={200}
      placeholder={placeholder}
      aria-label={label}
      className="h-7 w-full min-w-[9rem] rounded-md border border-line-strong bg-surface px-2 text-[13px] font-normal text-fg outline-none placeholder:text-fg-4"
    />
  );
}

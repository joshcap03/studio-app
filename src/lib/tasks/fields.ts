// A tracker row's fields as the member reads them, and as the agent saves them. The agent's own
// placeholders ("None", "n/a") are no detail at all, so they're never saved or shown; and every
// row of a collection shows its details in the same order, so a list reads as one list.

const BLANK = new Set(["", "none", "n/a", "na", "null", "nil", "unknown", "tbd", "-", "–", "—", "nothing", "not applicable", "not available"]);
// "Pay: not listed" says only that nothing was found.
const NOT_FOUND = /^(not (listed|specified|stated|disclosed|mentioned|given|provided|shown|seen|found)|unspecified|undisclosed|unlisted)$/;

/** A details line holds a field this long or shorter; longer ones wait for the row to open. */
export const SHORT_FIELD = 32;

/** True for a value that says nothing: empty, or a placeholder like "None" or "n/a". */
export function isBlankValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") {
    const text = value.replace(/\s+/g, " ").trim().toLowerCase().replace(/\.$/, "");
    return BLANK.has(text) || NOT_FOUND.test(text);
  }
  if (Array.isArray(value)) return value.every(isBlankValue);
  if (typeof value === "object") return Object.values(value).every(isBlankValue);
  return false;
}

/** The fields without the blank ones, for saving what the agent reported. */
export function withoutBlanks(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => !isBlankValue(value)));
}

/** A field's name as words ("next_step" → "next step"). */
export const fieldLabel = (key: string) => key.replace(/[-_]+/g, " ").trim();

/** A field's value as one line of text, or "" when it can't be read as text. */
function fieldText(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value) && value.every((v) => typeof v === "string" || typeof v === "number")) {
    return value.map((v) => String(v).trim()).filter(Boolean).join(", ");
  }
  return "";
}

interface Row {
  title: string;
  status: string | null;
  fields: Record<string, unknown>;
}

/**
 * A row's fields worth showing, as text and in the order saved: no blanks, nothing that can't be
 * read as text, and nothing the title or status already says (the company in "Role - Company").
 */
export function shownFields(row: Row): [key: string, text: string][] {
  const title = row.title.toLowerCase();
  const status = row.status?.toLowerCase();
  return Object.entries(row.fields).flatMap(([key, value]): [string, string][] => {
    if (isBlankValue(value)) return [];
    const text = fieldText(value);
    const lower = text.toLowerCase();
    if (!text || isBlankValue(text) || lower === status || (lower.length >= 3 && title.includes(lower))) return [];
    return [[key, text]];
  });
}

/**
 * The fields a collection's table shows as columns, the same ones on every row: the short ones
 * most rows have (a long one, like notes, is read with the row open).
 */
export function detailColumns(rows: Row[], max = 3): string[] {
  const counts = new Map<string, { short: number; long: number }>();
  for (const row of rows) {
    for (const [key, text] of shownFields(row)) {
      const count = counts.get(key) ?? { short: 0, long: 0 };
      if (text.length <= SHORT_FIELD) count.short += 1;
      else count.long += 1;
      counts.set(key, count);
    }
  }
  return [...counts]
    .filter(([, c]) => c.short >= 2 * c.long)
    .sort((a, b) => b[1].short - a[1].short || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([key]) => key);
}

/** One row's values for the collection's columns, in their order ("" where it has none). */
export function detailCells(row: Row, columns: string[]): string[] {
  const byKey = new Map(shownFields(row));
  return columns.map((key) => byKey.get(key) ?? "");
}

/** Each collection's field names, most used first, so the agent saves new rows the same way. */
export function fieldsByCollection(rows: (Row & { collection: string })[], max = 12): { collection: string; fields: string[] }[] {
  const byCollection = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const counts = byCollection.get(row.collection) ?? new Map<string, number>();
    for (const [key, value] of Object.entries(row.fields)) if (!isBlankValue(value)) counts.set(key, (counts.get(key) ?? 0) + 1);
    byCollection.set(row.collection, counts);
  }
  return [...byCollection].map(([collection, counts]) => ({
    collection,
    fields: [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, max)
      .map(([key]) => key),
  }));
}

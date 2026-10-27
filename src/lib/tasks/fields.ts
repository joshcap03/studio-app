// A tracker row's fields as the member reads them, and as the agent saves them. The agent's own
// placeholders ("None", "n/a") are no detail at all, so they're never saved or shown; and every
// row of a collection shows its details in the same order, so a list reads as one list.

const BLANK = new Set(["", "none", "n/a", "na", "null", "nil", "unknown", "tbd", "-", "–", "—", "nothing", "not applicable", "not available"]);
// "Pay: not listed" says only that nothing was found.
const NOT_FOUND = /^(not (listed|specified|stated|disclosed|mentioned|given|provided|shown|seen|found)|unspecified|undisclosed|unlisted)$/;

/** A field this long or shorter is short: it fits a sheet's narrow column. */
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

/** A field's value as a sheet cell's text: "" when it's blank, null when it isn't text (a nested object), which a cell shows but can't edit. */
export function cellText(value: unknown): string | null {
  if (isBlankValue(value)) return "";
  return fieldText(value) || null;
}

/**
 * A collection's columns as a sheet: every field its rows have, the same for every row. Short
 * ones come first, those most rows have leading; long ones (notes) come last, as wider columns.
 */
export function sheetColumns(rows: Row[]): { key: string; long: boolean }[] {
  const counts = new Map<string, { short: number; long: number }>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row.fields)) {
      if (isBlankValue(value)) continue;
      const count = counts.get(key) ?? { short: 0, long: 0 };
      if ((fieldText(value) || JSON.stringify(value)).length <= SHORT_FIELD) count.short += 1;
      else count.long += 1;
      counts.set(key, count);
    }
  }
  return [...counts]
    .map(([key, c]) => ({ key, long: c.long > c.short, count: c.short + c.long }))
    .sort((a, b) => Number(a.long) - Number(b.long) || b.count - a.count || a.key.localeCompare(b.key))
    .map(({ key, long }) => ({ key, long }));
}

/** A column name the member typed as a field key, the way the agent writes them ("Next step" → "next_step"). */
export function fieldKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
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

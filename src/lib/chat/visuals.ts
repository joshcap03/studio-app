import { z } from "zod";
import { appForToolkit } from "@/lib/apps";
import { MAX_VISUALS, type Timeline, type Visual } from "@/lib/types";

// Charts, key numbers, and tables an investigation reported through its report_visual tool.
// Only the shapes below are drawn; anything malformed is dropped rather than guessed at.

/** Strings, and numbers written out ("23"); anything else becomes empty and is dropped. */
const text = (max: number) =>
  z
    .union([z.string(), z.number().finite().transform(String)])
    .catch("")
    .transform((s) => s.replace(/\s+/g, " ").trim().slice(0, max));

/** "$1,200", "12%", 3 → number; anything else → null. */
const amount = z.unknown().transform((v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = Number(v.replace(/[$€£,%\s]/g, ""));
  return v.trim() && Number.isFinite(n) ? n : null;
});

const base = {
  title: text(200),
  app: z.string().regex(/^[a-z0-9_]{1,40}$/).optional().catch(undefined),
};

const chart = z.object({
  ...base,
  kind: z.literal("chart"),
  chart: z.enum(["bar", "line"]).catch("bar"),
  unit: text(12).catch(""),
  labels: z.array(text(40)).min(2).max(31),
  series: z.array(z.object({ name: text(60).catch(""), values: z.array(amount).max(31) })).min(1).max(4),
});

const stats = z.object({
  ...base,
  kind: z.literal("stats"),
  items: z
    .array(
      z.object({
        label: text(80),
        value: text(40),
        change: text(60).optional(),
        tone: z.enum(["good", "bad", "neutral"]).optional().catch(undefined),
      }),
    )
    .min(1)
    .max(6),
});

const table = z.object({
  ...base,
  kind: z.literal("table"),
  columns: z.array(text(60)).min(2).max(6),
  rows: z.array(z.array(text(200)).max(6)).min(1).max(20),
});

const schema = z.discriminatedUnion("kind", [chart, stats, table]);

/** Validates one reported visual. Null when it can't be drawn honestly. */
export function buildVisual(raw: unknown): Visual | null {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return null;
  const v = parsed.data;
  const app = v.app ? appForToolkit(v.app) : undefined;
  const head = { title: v.title, ...(app ? { app } : {}) };

  if (v.kind === "chart") {
    const series = v.series
      .filter((s) => s.values.length === v.labels.length && s.values.some((n) => n !== null))
      .map((s) => ({ name: s.name, values: s.values }));
    return series.length > 0 ? { ...head, kind: "chart", chart: v.chart, unit: v.unit, labels: v.labels, series } : null;
  }
  if (v.kind === "stats") {
    const items = v.items
      .filter((i) => i.label && i.value)
      .map(({ change, tone, ...item }) => ({ ...item, ...(change ? { change } : {}), ...(tone ? { tone } : {}) }));
    return items.length > 0 ? { ...head, kind: "stats", items } : null;
  }
  const rows = v.rows.map((r) => v.columns.map((_, i) => r[i] ?? "")).filter((r) => r.some(Boolean));
  return rows.length > 0 ? { ...head, kind: "table", columns: v.columns, rows } : null;
}

/** The investigation with one more visual (repeats and anything past the limit are skipped). */
export function withVisual(timeline: Timeline | null, visual: Visual): Timeline {
  const current = timeline ?? { question: "", entries: [], causes: [] };
  const visuals = current.visuals ?? [];
  const key = JSON.stringify(visual);
  if (visuals.length >= MAX_VISUALS || visuals.some((v) => JSON.stringify(v) === key)) return current;
  return { ...current, visuals: [...visuals, visual] };
}

"use client";

import type { Visual } from "@/lib/types";
import { AppGlyph } from "./app-glyph";

/**
 * Charts, key numbers, and tables an investigation drew from what it read. Each is drawn
 * exactly as reported (see src/lib/chat/visuals.ts); nothing here infers or fills in data.
 */
export function VisualView({ visual }: { visual: Visual }) {
  return (
    <figure className="mb-3 rounded-xl border border-line bg-surface px-4 pt-3 pb-3 animate-fade-up">
      <figcaption className="mb-2.5 flex items-center gap-2 text-[12px] font-medium text-fg-2">
        {visual.app ? <AppGlyph app={visual.app} size={16} /> : null}
        <span className="min-w-0 flex-1 truncate" title={visual.title}>
          {visual.title}
        </span>
      </figcaption>
      {visual.kind === "chart" ? <Chart visual={visual} /> : visual.kind === "stats" ? <Stats visual={visual} /> : <Table visual={visual} />}
    </figure>
  );
}

type Of<K extends Visual["kind"]> = Extract<Visual, { kind: K }>;

const SERIES = ["chart-1", "chart-2", "chart-3", "chart-4"] as const;
const FILL = { "chart-1": "fill-chart-1", "chart-2": "fill-chart-2", "chart-3": "fill-chart-3", "chart-4": "fill-chart-4" };
const STROKE = { "chart-1": "stroke-chart-1", "chart-2": "stroke-chart-2", "chart-3": "stroke-chart-3", "chart-4": "stroke-chart-4" };
const SWATCH = { "chart-1": "bg-chart-1", "chart-2": "bg-chart-2", "chart-3": "bg-chart-3", "chart-4": "bg-chart-4" };

/** 1234.5 with "$" → "$1.2K"; with "orders" → "1.2K orders". */
function formatAmount(n: number, unit: string, compact = true): string {
  const num = new Intl.NumberFormat(undefined, compact ? { notation: "compact", maximumFractionDigits: 1 } : { maximumFractionDigits: 2 }).format(n);
  if (!unit) return num;
  if (/^[$€£¥]$/.test(unit)) return n < 0 ? `-${unit}${num.slice(1)}` : `${unit}${num}`;
  return unit === "%" ? `${num}%` : `${num} ${unit}`;
}

/** Up to `max` label positions, evenly spread and always including the first and last. */
function tickIndexes(count: number, max: number): number[] {
  if (count <= max) return [...Array(count).keys()];
  const step = (count - 1) / (max - 1);
  return [...new Set([...Array(max).keys()].map((i) => Math.round(i * step)))];
}

function Chart({ visual }: { visual: Of<"chart"> }) {
  const W = 320;
  const H = 150;
  const left = 38;
  const bottom = 18;
  const plotW = W - left;
  const plotH = H - bottom - 6;
  const values = visual.series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values) || 1;
  const y = (v: number) => 6 + plotH - ((v - lo) / (hi - lo)) * plotH;
  const n = visual.labels.length;
  const slot = plotW / n;
  const x = (i: number) => left + slot * (i + 0.5);
  const grid = [lo, lo + (hi - lo) / 2, hi];
  const ticks = tickIndexes(n, 6);
  const tip = (si: number, i: number, v: number | null) =>
    `${visual.labels[i]}${visual.series.length > 1 ? ` · ${visual.series[si].name}` : ""}: ${v === null ? "no data" : formatAmount(v, visual.unit, false)}`;

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full overflow-visible" role="img" aria-label={visual.title}>
        {grid.map((g, i) => (
          <g key={i}>
            <line x1={left} x2={W} y1={y(g)} y2={y(g)} className="stroke-line" strokeWidth={1} />
            <text x={left - 6} y={y(g) + 3.5} textAnchor="end" className="fill-fg-3 text-[10px] tabular-nums">
              {formatAmount(g, visual.unit)}
            </text>
          </g>
        ))}
        {ticks.map((i) => (
          <text key={i} x={x(i)} y={H - 3} textAnchor="middle" className="fill-fg-3 text-[10px]">
            {visual.labels[i].length > 10 ? `${visual.labels[i].slice(0, 9)}…` : visual.labels[i]}
          </text>
        ))}
        {visual.chart === "bar"
          ? visual.series.map((s, si) => {
              const barW = Math.max(2, Math.min(18, (slot * 0.7) / visual.series.length));
              return s.values.map((v, i) =>
                v === null ? null : (
                  <rect
                    key={`${si}:${i}`}
                    x={x(i) - (barW * visual.series.length) / 2 + barW * si}
                    y={Math.min(y(v), y(0))}
                    width={barW - (visual.series.length > 1 ? 1 : 0)}
                    height={Math.max(1, Math.abs(y(v) - y(0)))}
                    rx={2}
                    className={FILL[SERIES[si]]}
                  >
                    <title>{tip(si, i, v)}</title>
                  </rect>
                ),
              );
            })
          : visual.series.map((s, si) => {
              // Gaps (no number) break the line rather than being drawn as zero.
              const path = s.values
                .map((v, i) => (v === null ? null : `${i === 0 || s.values[i - 1] === null ? "M" : "L"}${x(i)},${y(v)}`))
                .filter(Boolean)
                .join(" ");
              return (
                <g key={si}>
                  <path d={path} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className={STROKE[SERIES[si]]} />
                  {s.values.map((v, i) =>
                    v === null ? null : (
                      <circle key={i} cx={x(i)} cy={y(v)} r={n > 14 ? 2 : 3} className={`${FILL[SERIES[si]]} stroke-surface`} strokeWidth={1.5}>
                        <title>{tip(si, i, v)}</title>
                      </circle>
                    ),
                  )}
                </g>
              );
            })}
      </svg>
      {visual.series.length > 1 ? (
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-fg-2">
          {visual.series.map((s, si) => (
            <li key={si} className="flex items-center gap-1.5">
              <span className={`size-2 rounded-sm ${SWATCH[SERIES[si]]}`} aria-hidden="true" />
              {s.name}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function Stats({ visual }: { visual: Of<"stats"> }) {
  return (
    <dl className="grid grid-cols-2 gap-2">
      {visual.items.map((item, i) => (
        <div key={i} className="rounded-lg bg-subtle px-3 py-2">
          <dt className="truncate text-[11.5px] text-fg-3" title={item.label}>
            {item.label}
          </dt>
          <dd className="mt-0.5 text-[17px] font-semibold tracking-[-0.01em] text-fg tabular-nums">{item.value}</dd>
          {item.change ? (
            <dd
              className={`text-[11.5px] tabular-nums ${item.tone === "good" ? "text-success" : item.tone === "bad" ? "text-danger" : "text-fg-3"}`}
            >
              {item.change}
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}

function Table({ visual }: { visual: Of<"table"> }) {
  return (
    <div className="scroll-quiet -mx-1 overflow-x-auto">
      <table className="w-full border-collapse text-left text-[12.5px] leading-snug">
        <thead>
          <tr>
            {visual.columns.map((c, i) => (
              <th key={i} className="border-b border-line px-1 pb-1.5 font-medium whitespace-nowrap text-fg-3">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visual.rows.map((row, r) => (
            <tr key={r} className="border-b border-line last:border-0">
              {row.map((cell, c) => (
                <td key={c} className={`px-1 py-1.5 align-top ${c === 0 ? "text-fg" : "text-fg-2"}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

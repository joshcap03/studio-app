import { z } from "zod";
import { safeUrl } from "@/lib/agent/tools/sanitize";
import { appForToolkit } from "@/lib/apps";
import {
  MAX_TIMELINE_CAUSES,
  MAX_TIMELINE_ENTRIES,
  type ActivityStep,
  type Artifact,
  type Timeline,
  type TimelineEntry,
} from "@/lib/types";

// A "why?" investigation's timeline, as the agent reported it through its report_timeline
// tool. The agent's links are only trusted when this run's own tool results returned them:
// anything else is kept as a claim, marked unverified, with no link.

const text = (max: number) => z.string().transform((s) => s.replace(/\s+/g, " ").trim().slice(0, max));

const rawSchema = z.object({
  question: text(300).default(""),
  entries: z
    .array(
      z.object({
        when: text(40),
        what: text(300),
        app: z.string().regex(/^[a-z0-9_]{1,40}$/).optional().catch(undefined),
        url: z.string().optional().catch(undefined),
      }),
    )
    .max(MAX_TIMELINE_ENTRIES * 2),
  causes: z
    .array(z.object({ text: text(400), entries: z.array(z.number().int().nonnegative()).max(MAX_TIMELINE_ENTRIES).default([]) }))
    .max(MAX_TIMELINE_CAUSES * 2)
    .default([]),
});

export type RawTimeline = z.input<typeof rawSchema>;

/** Every link this run's tool results actually showed. */
export function linksSeen(activity: ActivityStep[], artifacts: Artifact[]): Set<string> {
  const seen = new Set<string>();
  const add = (url: string | undefined) => {
    const safe = safeUrl(url);
    if (safe) seen.add(safe);
  };
  for (const step of activity) {
    const p = step.preview;
    if (!p) continue;
    if (p.type === "sources" || p.type === "items") for (const item of p.items) add(item.url);
    else if (p.type === "link") add(p.url);
  }
  for (const a of artifacts) add(a.url);
  return seen;
}

/** Validates the agent's timeline and checks its links. Null when there's nothing usable. */
export function buildTimeline(raw: unknown, seen: Set<string>): Timeline | null {
  const parsed = rawSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { question, causes } = parsed.data;

  const entries = parsed.data.entries
    .map((e, index) => ({ e, index, at: Date.parse(e.when) }))
    .filter(({ e }) => e.when && e.what)
    .slice(0, MAX_TIMELINE_ENTRIES);
  // Oldest first; entries without a parseable date keep their reported order at the end.
  entries.sort((a, b) => (Number.isNaN(a.at) ? Infinity : a.at) - (Number.isNaN(b.at) ? Infinity : b.at) || a.index - b.index);
  const position = new Map(entries.map(({ index }, i) => [index, i]));

  const out: TimelineEntry[] = entries.map(({ e }) => {
    const url = safeUrl(e.url);
    const verified = Boolean(url && seen.has(url));
    return { when: e.when, what: e.what, ...(e.app ? { app: appForToolkit(e.app) } : {}), ...(verified ? { url } : {}), verified };
  });
  if (out.length === 0) return null;

  return {
    question,
    entries: out,
    causes: causes
      .filter((c) => c.text)
      .slice(0, MAX_TIMELINE_CAUSES)
      .map((c) => ({
        text: c.text,
        entries: [...new Set(c.entries.map((i) => position.get(i)).filter((i): i is number => i !== undefined))].sort((a, b) => a - b),
      })),
  };
}

import { appName } from "@/lib/apps";
import type { ActivityStep, Artifact, StepPreview } from "@/lib/types";

// One-line summaries of what the agent found or produced, for the work panel. The chat
// timeline says what the agent is *doing*; findings say what it *saw*. Built only from a
// step's receipt (or failure reason). Steps with nothing to report produce no finding.

export interface Finding {
  id: string;
  app?: string;
  text: string;
  tone: "normal" | "problem";
  /** A placeholder line ("Looked through Granola"); the agent's own words are preferred. */
  generic?: boolean;
  step?: ActivityStep;
  artifact?: Artifact;
}

const EMAIL_APPS = new Set(["gmail", "outlook"]);
const NOT_CONNECTED = /^[^.]+ isn't connected\.$/;

/**
 * Findings for one reply, in order. A free-form app answer is summarized by the line the
 * agent wrote right after it ("Found 9 meetings."), since raw answers make poor headlines.
 */
export function findingsForReply(steps: ActivityStep[], artifacts: Artifact[]): Finding[] {
  const out: Finding[] = [];
  steps.forEach((step, i) => {
    if (step.hidden || step.action === "note") return;
    const after = steps.slice(i + 1).find((s) => !s.hidden && (s.action === "note" || s.status !== "running"));
    const said = after?.action === "note" ? summaryFromAgent(after.label) : undefined;
    const finding = findingFor(step, after?.action === "note" ? after.label : undefined);
    // Any tool: when a step has nothing specific to say, use the agent's line about it.
    if ((!finding || finding.generic) && said && step.status === "done") {
      out.push({ id: step.id, app: step.app, text: said, tone: "normal", step });
    } else if (finding) {
      out.push(finding);
    }
  });
  return [...out, ...artifacts.map(findingForArtifact)];
}

export function findingFor(step: ActivityStep, agentSaid?: string): Finding | null {
  if (step.status === "failed") {
    // An app that isn't connected is a fact about the setup, not something going wrong.
    if (step.detail && NOT_CONNECTED.test(step.detail)) return { id: step.id, app: step.app, text: step.detail, tone: "normal", step };
    return { id: step.id, app: step.app, text: step.detail ? `Hit a snag: ${step.detail}` : step.label, tone: "problem", step };
  }
  const p = step.preview;
  if (step.status !== "done" || !p) return null;
  const base = { id: step.id, app: step.app, tone: "normal" as const, step };

  switch (p.type) {
    case "sources": {
      const n = p.total ?? p.items.length;
      const domains = [...new Set(p.items.map((s) => s.domain))].slice(0, 2).join(", ");
      return { ...base, text: `Read ${n} ${plural(n, "source")}: ${domains}${p.items.length > 2 ? "…" : ""}` };
    }
    case "items": {
      const n = p.total ?? p.items.length;
      const first = p.items[0]?.primary;
      if (n === 0) {
        const about = p.query && p.query.length <= 40 ? ` about “${p.query}”` : "";
        return { ...base, text: step.app === "memory" ? `Nothing in memory${about} yet` : `Found nothing${about} in ${appName(step.app)}` };
      }
      if (step.action === "write") return { ...base, text: first ? `Sent: “${first}”` : "Done" };
      if (EMAIL_APPS.has(step.app ?? "")) {
        return { ...base, text: `Found ${n} ${plural(n, "email")}${first ? ` · latest “${first}”` : ""}` };
      }
      if (step.app === "memory") {
        return { ...base, text: n === 1 && first ? `Remembered: ${first}` : `Remembered ${n} ${plural(n, "thing")}${first ? `, like “${first}”` : ""}` };
      }
      const about = p.query && p.query.length <= 40 ? ` for “${p.query}”` : "";
      return { ...base, text: `Found ${n} ${plural(n, "item")}${about} in ${appName(step.app)}${first ? `: ${first}${n > 1 ? "…" : ""}` : ""}` };
    }
    case "table": {
      const n = p.total ?? p.rows.length;
      const where = p.title ? ` to “${p.title}”` : "";
      return { ...base, text: step.action === "write" ? `Wrote ${n} ${plural(n, "row")}${where}` : `Read ${n} ${plural(n, "row")}` };
    }
    case "code":
      return p.steps?.length ? { ...base, text: p.steps.at(-1)! } : { ...base, text: "Worked through the data", generic: true };
    case "text":
      if (step.app === "calculator") return { ...base, text: `Calculated: ${short(p.text)}` };
      // Written by the step's own interpretation (plan progress, a tracked row, a filed link), never raw output.
      if (step.app === "tracker" || step.app === "library") return { ...base, text: short(p.text) };
      if (step.app === "memory") {
        return { ...base, text: step.label.startsWith("Noted") ? `Noted: “${short(p.text)}”` : `Remembered: ${short(p.text)}` };
      }
      // Free-form answers from apps: say it in the agent's words when it summarized the
      // result, otherwise just where it looked. Raw answer text is never the headline; it
      // stays one click away.
      {
        const said = summaryFromAgent(agentSaid);
        return said ? { ...base, text: said } : { ...base, text: lookedThrough(appName(step.app), p.query), generic: true };
      }
    case "link":
      return { ...base, text: step.action === "connect" ? `${p.title ?? "A connection"} needs your OK` : `Opened ${p.title ?? "a page"}` };
  }
}

/** The receipt of a plan update ("Plan: 1 of 3 steps done; next: …"). */
const PLAN_LINE = /^Plan: \d+ of \d+ steps? done/;

/**
 * Each reply's findings, in order, without a plan line that only repeats the last one shown:
 * the agent saves its plan on most turns, and an unchanged plan isn't news.
 */
export function withoutRepeatedPlans(replies: Finding[][]): Finding[][] {
  let last: string | undefined;
  return replies.map((findings) =>
    findings.filter((f) => {
      if (f.app !== "tracker" || !PLAN_LINE.test(f.text)) return true;
      if (f.text === last) return false;
      last = f.text;
      return true;
    }),
  );
}

export function findingForArtifact(artifact: Artifact): Finding {
  return {
    id: `artifact:${artifact.id}`,
    text: `Made “${artifact.title}”${artifact.source ? ` in ${artifact.source}` : ""}`,
    tone: "normal",
    artifact,
    app: artifact.kind === "spreadsheet" ? "sheets" : artifact.kind === "document" ? "docs" : undefined,
  };
}

/**
 * One reply's findings arranged so the panel doesn't overwhelm: what the agent found or
 * made comes first, in order, and the looking it did to get there (web reads, lookups with
 * nothing specific to say) folds into one line per app below it. A lone lookup stays a
 * plain line. Works on any tool: lookups are told apart by their receipt, not their name.
 */
export type Chunk = { kind: "finding"; finding: Finding } | ResearchChunk;

export interface ResearchChunk {
  kind: "research";
  id: string;
  app?: string;
  text: string;
  /** The sites read most, for a web bundle. */
  detail?: string;
  findings: Finding[];
  /** Every source the bundle read, once each, for a web bundle. */
  sources?: Extract<StepPreview, { type: "sources" }>;
}

export function chunkFindings(findings: Finding[]): Chunk[] {
  const results: Chunk[] = [];
  const lookups = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = lookupKey(f);
    if (key === null) results.push({ kind: "finding", finding: f });
    else lookups.set(key, [...(lookups.get(key) ?? []), f]);
  }
  const research = [...lookups.entries()].map(([key, group]): Chunk =>
    group.length === 1 ? { kind: "finding", finding: group[0] } : key === SOURCES ? sourcesChunk(group) : lookupsChunk(group),
  );
  return [...results, ...research];
}

const SOURCES = "sources";

/** Which bundle a finding folds into, or null when it's something found or made. */
function lookupKey(f: Finding): string | null {
  if (f.tone === "problem" || f.artifact || !f.step) return null;
  if (f.step.preview?.type === "sources") return SOURCES;
  return f.generic ? `app:${f.app ?? ""}` : null;
}

function sourcesChunk(group: Finding[]): ResearchChunk {
  const seen = new Map<string, { title: string; url: string; domain: string }>();
  const domains = new Map<string, number>();
  let unlisted = 0;
  for (const f of group) {
    const p = f.step?.preview;
    if (p?.type !== "sources") continue;
    unlisted += Math.max(0, (p.total ?? p.items.length) - p.items.length);
    for (const s of p.items) {
      if (seen.has(s.url)) continue;
      seen.set(s.url, s);
      domains.set(s.domain, (domains.get(s.domain) ?? 0) + 1);
    }
  }
  const n = seen.size + unlisted;
  const top = [...domains.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
  const rest = top.length - 3;
  return {
    kind: "research",
    id: `research:${group[0].id}`,
    app: group[0].app,
    text: `Read ${n} ${plural(n, "source")} across ${group.length} searches`,
    detail: top.length ? `${top.slice(0, 3).join(", ")}${rest > 0 ? ` and ${rest} more ${plural(rest, "site")}` : ""}` : undefined,
    findings: group,
    sources: { type: "sources", items: [...seen.values()], total: n },
  };
}

function lookupsChunk(group: Finding[]): ResearchChunk {
  const app = group[0].app;
  return {
    kind: "research",
    id: `research:${group[0].id}`,
    app,
    text: `Looked through ${appName(app)} ${group.length} times`,
    findings: group,
  };
}

/** The informative part of the agent's line ("Found 9 meetings. Let me…" → "Found 9 meetings."). */
export function summaryFromAgent(line: string | undefined): string | undefined {
  if (!line) return undefined;
  const sentences = clean(line).match(/[^.!?]+[.!?]?/g) ?? [];
  const real = sentences.map((s) => s.trim()).find((s) => s.length > 3 && !/^(let me|i['’]ll|i will|i['’]m going to|next|now)\b/i.test(s));
  if (!real) return undefined;
  // Keep what was found; drop the plan that follows ("…, so I'll widen the search").
  const found = real.replace(/[,;:–—-]?\s*(so|and|then)\s+(i['’]ll|i will|let me|i['’]m going to)\b.*$/i, "").trim();
  return short(/[.!?]$/.test(found) ? found : `${found}.`);
}

function lookedThrough(app: string, query: string | undefined): string {
  return query && query.length <= 30 ? `Looked through ${app} for “${query}”` : `Looked through ${app}`;
}

/** Strips markup and stray symbols so a finding reads like a sentence. */
function clean(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function short(text: string): string {
  const line = clean(text);
  return line.length > 90 ? `${line.slice(0, 89).trimEnd()}…` : line;
}

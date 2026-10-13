import { appName } from "@/lib/apps";
import type { ActivityStep, Artifact } from "@/lib/types";

// One-line summaries of what the agent found or produced, for the work panel. The chat
// timeline says what the agent is *doing*; findings say what it *saw*. Built only from a
// step's receipt (or failure reason). Steps with nothing to report produce no finding.

export interface Finding {
  id: string;
  app?: string;
  text: string;
  tone: "normal" | "problem";
  step?: ActivityStep;
  artifact?: Artifact;
}

const EMAIL_APPS = new Set(["gmail", "outlook"]);

/**
 * Findings for one reply, in order. A free-form app answer is summarized by the line the
 * agent wrote right after it ("Found 9 meetings."), since raw answers make poor headlines.
 */
export function findingsForReply(steps: ActivityStep[], artifacts: Artifact[]): Finding[] {
  const out: Finding[] = [];
  steps.forEach((step, i) => {
    if (step.hidden || step.action === "note") return;
    const after = steps.slice(i + 1).find((s) => !s.hidden && (s.action === "note" || s.status !== "running"));
    const finding = findingFor(step, after?.action === "note" ? after.label : undefined);
    if (finding) out.push(finding);
  });
  return [...out, ...artifacts.map(findingForArtifact)];
}

export function findingFor(step: ActivityStep, agentSaid?: string): Finding | null {
  if (step.status === "failed") {
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
      return p.steps?.length ? { ...base, text: p.steps.at(-1)! } : null;
    case "text":
      if (step.app === "memory") {
        return { ...base, text: step.label.startsWith("Noted") ? `Noted: “${short(p.text)}”` : `Remembered: ${short(p.text)}` };
      }
      // Free-form answers from apps: say it in the agent's words when it summarized the
      // result, otherwise just where it looked. Raw answer text is never the headline; it
      // stays one click away.
      return { ...base, text: summaryFromAgent(agentSaid) ?? lookedThrough(appName(step.app), p.query) };
    case "link":
      return { ...base, text: step.action === "connect" ? `${p.title ?? "A connection"} needs your OK` : `Opened ${p.title ?? "a page"}` };
  }
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

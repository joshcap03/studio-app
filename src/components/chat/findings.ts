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

export function findingFor(step: ActivityStep): Finding | null {
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
      const about = p.query ? ` for “${p.query}”` : "";
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
      // Free-form answers from apps: what was asked, and the answer's first real sentence.
      // The full text stays one click away.
      return { ...base, text: answerLine(appName(step.app), p.query, p.text) };
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

/** "Granola · “Franzi” — 9 meetings mention Franzi…" */
export function answerLine(app: string, query: string | undefined, text: string): string {
  const lead = firstRealSentence(text);
  const asked = query ? ` · “${query.length > 40 ? `${query.slice(0, 39).trimEnd()}…` : query}”` : "";
  return lead ? `${app}${asked} — ${lead}` : `${app}${asked}: answer ready`;
}

/** The first sentence that says something, skipping preambles like "I'll review…". */
export function firstRealSentence(text: string): string {
  const plain = text
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = plain.match(/[^.!?]+[.!?]?/g) ?? [];
  const real = sentences.map((s) => s.trim()).find((s) => s.length > 12 && !/^(i['’]ll|i will|let me|i['’]m going to|sure|okay|ok|here(['’]s| is)|got it)\b/i.test(s));
  return real ? short(real) : "";
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function short(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 90 ? `${line.slice(0, 89).trimEnd()}…` : line;
}

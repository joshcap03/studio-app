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
      return { ...base, text: `Found ${n} ${plural(n, "item")}${first ? `: ${first}${n > 1 ? "…" : ""}` : ""}` };
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
      // Free-form answers from apps can be long or sensitive: say where it came from, and
      // keep the text one click away.
      return { ...base, text: `Got results from ${appName(step.app)}` };
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

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function short(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 90 ? `${line.slice(0, 89).trimEnd()}…` : line;
}

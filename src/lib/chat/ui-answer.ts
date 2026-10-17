import type { UiForm } from "@/lib/types";

// Turning a filled-in form into the member's next message. Shared by the form card (browser)
// and tests; kept apart from ui.ts so the browser doesn't load the skill library.

/**
 * What the member filled in on a form: text per field, picks (a rank's in order), list entries,
 * file names, a scale's point as text, or verdicts as {id, verdict, reason} per judged item.
 */
export type FormValues = Record<string, string | string[] | Record<string, string>[]>;

/** The missing required answer, if any, as its label. */
export function missingAnswer(form: UiForm, values: FormValues): string | null {
  for (const f of form.fields) {
    if (!f.required) continue;
    const v = values[f.id];
    const empty = v === undefined || (typeof v === "string" ? !v.trim() : v.length === 0);
    if (empty) return f.label;
    // A required verdict wants a call on every item.
    if (f.kind === "verdict" && Array.isArray(v) && f.items.some((i) => !(v as Record<string, string>[]).some((x) => x.id === i.id && x.verdict))) return f.label;
  }
  return null;
}

/**
 * The message that answers a form: each answered field under its label, so it reads like
 * something the member wrote and the agent can quote it back. Files ride along as attachments.
 */
export function formAnswerText(form: UiForm, values: FormValues): string {
  const out: string[] = [];
  for (const f of form.fields) {
    const v = values[f.id];
    if (v === undefined || (typeof v === "string" ? !v.trim() : v.length === 0)) continue;
    if (f.kind === "list" && Array.isArray(v)) {
      const entries = (v as Record<string, string>[]).filter((e) => Object.values(e).some((x) => x?.trim()));
      if (!entries.length) continue;
      out.push(`${f.label}:`);
      entries.forEach((entry, i) => {
        out.push(`${f.itemLabel} ${i + 1}`);
        for (const p of f.parts) if (entry[p.id]?.trim()) out.push(`- ${p.label}: ${entry[p.id].trim()}`);
      });
    } else if (f.kind === "verdict" && Array.isArray(v)) {
      const calls = v as Record<string, string>[];
      const lines = f.items.flatMap((item) => {
        const call = calls.find((x) => x.id === item.id);
        if (call?.verdict === "keep") return [`- Kept: ${item.title}`];
        if (call?.verdict === "pass") return [`- Passed: ${item.title}${call.reason?.trim() ? ` (${call.reason.trim()})` : ""}`];
        return [];
      });
      if (!lines.length) continue;
      out.push(`${f.label}:`, ...lines);
    } else if (f.kind === "rank" && Array.isArray(v)) {
      out.push(`${f.label} (most important first): ${(v as string[]).map((o, i) => `${i + 1}. ${o}`).join("; ")}`);
    } else if (f.kind === "scale") {
      out.push(`${f.label}: ${String(v)} of ${f.steps} (1 = ${f.low}, ${f.steps} = ${f.high})`);
    } else if (f.kind === "file") {
      out.push(`${f.label}: ${f.keep ? "added" : "attached"} ${(v as string[]).join(", ")}${f.keep ? " to this agent's files" : ""}`);
    } else if (f.kind === "long_text") {
      out.push(`${f.label}:\n${String(v).trim()}`);
    } else {
      out.push(`${f.label}: ${Array.isArray(v) ? (v as string[]).join(", ") : String(v).trim()}`);
    }
  }
  return out.join("\n") || `${form.title}: nothing to add.`;
}

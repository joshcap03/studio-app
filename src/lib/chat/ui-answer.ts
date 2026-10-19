import { appName } from "@/lib/apps";
import type { UiForm } from "@/lib/types";

// Turning a filled-in form into the member's next message. Shared by the form card (browser)
// and tests; kept apart from ui.ts so the browser doesn't load the skill library.

/**
 * What the member filled in on a form: text per field, picks (a rank's in order), list entries,
 * file names, a scale's point as text, verdicts as {id, verdict, reason} per judged item, or
 * apps to connect as {app, status} with what the card saw when it was sent.
 */
export type FormValues = Record<string, string | string[] | Record<string, string>[]>;

/** What a connect field saw for one app: connected, not (skipped), or connections off for now. */
export type ConnectStatus = "connected" | "not_connected" | "unavailable";

const CONNECT_STATUS: Record<ConnectStatus, string> = {
  connected: "connected",
  not_connected: "skipped for now, not connected",
  unavailable: "not available yet, not connected",
};

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
    // Apps always get a line, so the agent knows a skipped one was skipped and doesn't offer it again.
    if (f.kind === "connect") {
      const seen = Array.isArray(v) ? (v as Record<string, string>[]) : [];
      const said = f.apps.map((app) => {
        const status = seen.find((x) => x.app === app)?.status as ConnectStatus | undefined;
        return { app, text: (status && CONNECT_STATUS[status]) || "skipped for now" };
      });
      // "Connect QuickBooks: connected"; a label that doesn't name its one app gets the name.
      const named = said.length === 1 && f.label.toLowerCase().includes(appName(said[0].app).toLowerCase());
      out.push(`${f.label}: ${named ? said[0].text : said.map((x) => `${appName(x.app)} ${x.text}`).join("; ")}`);
      continue;
    }
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
        // The link rides along, so the agent's next turn can see where each result came from.
        const where = item.link ? ` <${item.link}>` : "";
        if (call?.verdict === "keep") return [`- Kept: ${item.title}${where}`];
        if (call?.verdict === "pass") return [`- Passed: ${item.title}${where}${call.reason?.trim() ? ` (${call.reason.trim()})` : ""}`];
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

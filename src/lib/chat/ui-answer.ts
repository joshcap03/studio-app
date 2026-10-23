import { appName } from "@/lib/apps";
import type { Question, UiForm, UiResponse } from "@/lib/types";
import { voiceByKey } from "@/lib/voice/voices";

// Turning a filled-in form (or picks on the agent's questions) into the member's next message,
// and an applied proposal into what took effect. Shared by the cards (browser), a call's recap,
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

/** What applying a proposed setup did, in a line (the card's, and a call's recap). */
export function appliedText(a: Extract<UiResponse, { status: "applied" }>["applied"]): string {
  const parts = [
    a.name ? `named ${a.name}` : "",
    a.voice ? `sounds ${(voiceByKey(a.voice)?.label ?? a.voice).toLowerCase()}` : "",
    a.settings ? "updated what it's for and how it works" : "",
    a.tasks ? `${a.tasks} task${a.tasks === 1 ? "" : "s"} on` : "",
    a.skills ? `${a.skills} skill${a.skills === 1 ? "" : "s"} added` : "",
    a.memories ? `${a.memories} fact${a.memories === 1 ? "" : "s"} remembered` : "",
  ].filter(Boolean);
  const skipped = a.skipped ? ` ${a.skipped} item${a.skipped === 1 ? "" : "s"} couldn't be applied on your account.` : "";
  return (parts.length ? `Applied: ${parts.join(", ")}.` : "Applied. Nothing needed changing.") + skipped;
}

/**
 * The member's fixes to the guesses a proposal listed, as their next message: each guess they
 * said isn't right, with what is. The agent rewrites what it proposed and proposes it again.
 */
export function guessFixText(assumptions: string[], fixes: Record<number, string>): string {
  const wrong = assumptions.flatMap((a, i) => (fixes[i]?.trim() ? [`- You guessed: “${a}” Actually: ${fixes[i].trim()}`] : []));
  const right = assumptions.filter((_, i) => fixes[i] === undefined);
  return [
    "Some of your guesses aren't right:",
    ...wrong,
    ...(right.length ? ["", "The rest are right."] : []),
    "",
    "Rewrite it with these and propose it again.",
  ].join("\n");
}

/** The message that answers `questions` with the member's picks. */
export function answerText(questions: Question[], picks: string[][]): string {
  if (questions.length === 1) return picks[0].join(", ");
  return questions.map((q, i) => `${q.header ? `${q.header}:` : q.question} ${picks[i].join(", ")}`).join("\n");
}

/**
 * Whether `content` is picks on `questions` as the question card sends them (answerText), not
 * words of the member's own: each line only the question's options. Labels may hold commas, so
 * each line is matched label by label.
 */
export function isQuestionAnswer(questions: Question[], content: string): boolean {
  if (!questions.length) return false;
  const text = content.trim();
  if (questions.length === 1) return picksOf(text, questions[0]);
  const lines = text.split("\n");
  return (
    lines.length === questions.length &&
    questions.every((q, i) => {
      const lead = q.header ? `${q.header}:` : q.question;
      const line = lines[i].trim();
      return line === lead.trim() || (line.startsWith(`${lead} `) && picksOf(line.slice(lead.length + 1).trim(), q));
    })
  );
}

/** Whether `text` is one or more of the question's option labels, joined the way answerText joins them. */
function picksOf(text: string, question: Question): boolean {
  if (!text) return false;
  const labels = question.options.map((o) => o.label).filter(Boolean);
  const rest = (from: string, left: number): boolean =>
    left > 0 && labels.some((label) => from === label || (from.startsWith(`${label}, `) && rest(from.slice(label.length + 2), left - 1)));
  return rest(text, question.multiSelect ? labels.length : 1);
}

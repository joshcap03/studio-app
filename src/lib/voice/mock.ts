import { isBackchannel, isSendIntent, isStopIntent, normalizeSpeech } from "./intent";
import type { StageField, VoiceStage } from "./types";

// MOCK VOICE: for QA without a voice provider. The browser takes typed "speech" and shows the
// voice's words as captions, labeled "Mock voice" on the call. The voice front still runs for
// real (sealed context, prompt, markers, client tools); only its model is replaced by these
// scripted replies, which understand a small, predictable grammar:
//   "keep 1 and 2, pass on 3 it's an agency" · "Remote and hybrid" · "four" (a scale) ·
//   "pay first" (a ranking) · "target roles are product designer" · "send" · "stop".
// Anything else goes to the worker as the member's words.

export const MOCK_VOICE_LABEL = "Mock voice";

export interface BrainReply {
  text?: string;
  tools?: { name: string; args: Record<string, unknown> }[];
}

const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8 };
const num = (w: string) => (/^\d+$/.test(w) ? Number(w) : (NUMBERS[w] ?? ORDINALS[w]));

/** The scripted reply to what the member just said. */
export function mockReplyToSpeech(stage: VoiceStage | null, said: string): BrainReply {
  if (isStopIntent(said)) return { tools: [{ name: "stop_work", args: {} }] };
  const fills = stage?.form ? formFills(stage.form.fields, said) : [];
  const answers = stage?.questions ? questionAnswers(stage.questions, said) : [];
  const card = Boolean(stage?.form || stage?.questions?.length);
  const tools = [...fills.map((args) => ({ name: "fill_card", args })), ...(answers.length ? [{ name: "answer_question", args: { answers } }] : [])];
  if (card && isSendIntent(said)) return { tools: [...tools, { name: "send_card", args: {} }] };
  if (tools.length) return { tools };
  if (isBackchannel(said)) return { tools: [{ name: "skip_turn", args: {} }] };
  return { tools: [{ name: "send_message", args: {} }] };
}

/** The scripted line after the browser ran the tools, from what each one reported. */
export function mockReplyToResults(results: string[]): BrainReply {
  const lines = results.map((r) => {
    const [status, ...rest] = r.split(":");
    const detail = rest.join(":").trim();
    switch (status.trim().toLowerCase()) {
      case "filled":
        return `Got it: ${detail}`;
      case "heard":
        return `I heard ${detail.split("?")[0]}. Tap it on screen if that's right.`;
      case "sent":
        return "Sent.";
      case "handed off":
        return "On it.";
      case "held":
        return "Got it. I'll add that when this lands.";
      case "stopped":
        return "Stopped.";
      default:
        return detail || r;
    }
  });
  return { text: [...new Set(lines)].join(" ") };
}

function formFills(fields: StageField[], said: string): Record<string, unknown>[] {
  const words = normalizeSpeech(said).split(" ").filter(Boolean);
  const text = ` ${words.join(" ")} `;
  const out: Record<string, unknown>[] = [];
  const guesses: Record<string, unknown>[] = [];
  for (const f of fields) {
    if (f.tapOnly) continue;
    if (f.kind === "verdict" && f.items) {
      const calls = verdictCalls(words, f);
      if (calls.length) out.push({ field: f.id, value: calls });
    } else if ((f.kind === "choice" || f.kind === "multi_choice") && f.options) {
      const picked = f.options.filter((o) => text.includes(` ${normalizeSpeech(o)} `));
      // A word from one option ("tailor") is a guess, as a model's would be: the card asks first.
      const guessed = picked.length ? [] : f.options.flatMap((o) => normalizeSpeech(o).split(" ").filter((w) => w.length >= 5 && text.includes(` ${w} `)).slice(0, 1));
      if (picked.length) out.push({ field: f.id, value: f.kind === "choice" ? picked[0] : picked });
      else if (guessed.length === 1) guesses.push({ field: f.id, value: guessed[0] });
    } else if (f.kind === "rank" && f.options) {
      // "seniority first", or "rank pay, remote, seniority".
      const after = text.includes(" rank ") ? text.slice(text.indexOf(" rank ")) : null;
      const named = after
        ? f.options
            .map((o) => ({ o, at: after.indexOf(` ${normalizeSpeech(o)} `) }))
            .filter((x) => x.at >= 0)
            .sort((a, b) => a.at - b.at)
            .map((x) => x.o)
        : f.options.filter((o) => text.includes(` ${normalizeSpeech(o)} first `));
      if (named.length) out.push({ field: f.id, value: named });
    } else if (f.kind === "scale" && f.scale && !/\b(keep|pass)\b/.test(text)) {
      const n = words.map(num).find((x) => x !== undefined && x >= 1 && x <= f.scale!.steps);
      if (n !== undefined) out.push({ field: f.id, value: n });
    } else if (f.kind === "text" || f.kind === "long_text") {
      const label = normalizeSpeech(f.label);
      const match = new RegExp(`(?:^|[.!?]\\s*)${label.replace(/\s+/g, "[\\s\\W]+")}\\s*(?:is|are|:|should be)\\s+(.+)$`, "i").exec(said.trim());
      if (match) out.push({ field: f.id, value: match[1].replace(/[.!?]+$/, "").trim() });
    }
  }
  if (!out.length) out.push(...guesses);
  // One open text field and nothing else said: their words are the answer.
  const open = fields.filter((f) => (f.kind === "text" || f.kind === "long_text") && !f.tapOnly);
  if (!out.length && open.length === 1 && fields.filter((f) => !f.tapOnly).length === 1 && !isSendIntent(said) && !isBackchannel(said)) {
    out.push({ field: open[0].id, value: said.trim() });
  }
  return out;
}

/** "keep 1 and 2, pass on 3 it's an agency", "keep the first two", "pass on all". */
function verdictCalls(words: string[], field: StageField): Record<string, unknown>[] {
  const items = field.items ?? [];
  const calls = new Map<number, { item: number; verdict: string; reason?: string }>();
  let mode: "keep" | "pass" | null = null;
  let last: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "keep" || w === "pass") {
      mode = w;
      last = [];
      continue;
    }
    if (!mode) continue;
    if (w === "all" || w === "both" || w === "everything") {
      last = items.map((x) => x.n);
    } else if ((w === "first" || w === "last") && num(words[i + 1] ?? "") > 1) {
      const n = num(words[++i]);
      last = w === "first" ? items.slice(0, n).map((x) => x.n) : items.slice(-n).map((x) => x.n);
    } else if (num(w) !== undefined && num(w) <= items.length) {
      last = [...last, num(w)];
    } else if (["and", "on", "the", "number", "item", "one", "ones"].includes(w)) {
      continue;
    } else {
      // Past the numbers: for a pass, what's left of the clause is why.
      if (mode === "pass" && last.length) {
        const rest = words.slice(i).join(" ").split(/\b(?:keep|pass)\b/)[0].trim();
        const reason = field.reasons?.find((r) => ` ${rest} `.includes(` ${normalizeSpeech(r)} `)) ?? rest.replace(/^(its|it s|because|since|as|cause|thats)\s+/, "");
        for (const n of last) calls.set(n, { item: n, verdict: mode, ...(reason ? { reason } : {}) });
        last = [];
      }
      continue;
    }
    for (const n of last) if (!calls.has(n) || calls.get(n)!.verdict !== mode) calls.set(n, { item: n, verdict: mode });
  }
  return [...calls.values()];
}

function questionAnswers(questions: NonNullable<VoiceStage["questions"]>, said: string) {
  const text = ` ${normalizeSpeech(said)} `;
  return questions.flatMap((q, i) => {
    const picked = q.options.filter((o) => text.includes(` ${normalizeSpeech(o)} `));
    return picked.length ? [{ question: i + 1, option: q.multi ? picked : picked[0] }] : [];
  });
}

import { PLAN_STEP_DONE_LABEL, PLAN_STEP_LABEL } from "@/lib/agent/tools";
import { callOf } from "@/lib/chat/modality";
import { askOf, type MarkedMove } from "@/lib/chat/move";
import { appliedText, isQuestionAnswer } from "@/lib/chat/ui-answer";
import type { ActivityStep, Artifact, CallSummary, ChatMessage } from "@/lib/types";

// What a call came to, for the card after it in the chat: what the member asked (their own
// words, as the speech-to-text heard them), what the agent did (the steps and files its replies
// reported), what they decided (cards sent, questions answered, proposals applied, approvals
// answered while it was on, with their words when they said it), and what's still out. Built from the records alone, never from a
// model's account of the call, and read again as things change, so "still out" stays true once
// a job lands. A call that followed a task's run ("Do the first one now") has a recap where it
// went too, and the one where it was says the run is still out. Pure.

/**
 * How words held while the agent worked go along with the member's next message on a call, so
 * a recap can quote each part in their own words, without this joiner.
 */
const HELD_JOINER = "\n\nAlso, while you were working: ";

/** The member's next message on a call, with what they said while the agent was busy (`earlier`). */
export function withHeldWords(text: string, earlier: string): string {
  return earlier ? `${text}${HELD_JOINER}${earlier}` : text;
}

/**
 * A call as its recap reads it: the server's record of it, and (known only to the tab it was on)
 * where it followed a task's run. `followedFrom`: it came into this conversation following a
 * run, from this message (the run's first). `away`: runs it followed from here into their own
 * conversations, and how each stands now (its sidebar mark; null once it's done).
 */
export interface RecapCall extends CallSummary {
  followedFrom?: string;
  away?: { title: string; move: MarkedMove | null }[];
}

/** Decisions made just after hanging up (or on a clock a little behind the server's) still count. */
const AFTER_MS = 30_000;
const MAX_STEPS = 8;
const MAX_FILES = 6;

export interface CallRecap {
  callId: string;
  /** The message the recap goes after: the call's last. */
  after: string;
  seconds: number;
  /** What they said on the call, in their words. */
  asked: string[];
  /** Steps its replies did (failed ones say so), and what they made. */
  did: { label: string; failed: boolean }[];
  /** Steps past MAX_STEPS. */
  moreDone: number;
  made: Artifact[];
  /** What they decided while it was on, one line each. */
  decided: string[];
  /** What's still out: the job still going (out on it), or an OK or a card waiting on them. */
  out: { kind: "working" | "waiting"; text: string }[];
}

/**
 * The recap of `call` from the conversation's messages; null while it's going, or when it
 * neither had words said on it here nor followed a run here.
 */
export function callRecap(messages: ChatMessage[], call: RecapCall): CallRecap | null {
  if (call.endedAt === null) return null;
  const said = messages.flatMap((m, i) => (m.role === "user" && callOf(m.origin) === call.id ? [i] : []));
  const followed = call.followedFrom ? messages.findIndex((m) => m.id === call.followedFrom) : -1;
  if (!said.length && followed < 0) return null;
  const first = followed >= 0 && (!said.length || followed < said[0]) ? followed : said[0];
  const lastSaid = said.at(-1) ?? first;
  const until = call.endedAt + AFTER_MS;
  // The call's messages: from its first words to the reply to its last, and anything else
  // written before it ended.
  let last = messages[lastSaid + 1]?.role === "assistant" ? lastSaid + 1 : lastSaid;
  while (messages[last + 1] && messages[last + 1].createdAt <= call.endedAt) last += 1;
  const window = messages.slice(first, last + 1);
  const during = (at: number | undefined) => at !== undefined && at >= call.startedAt && at <= until;

  // Their words, without a card's answers (those are decisions) or the joiner held words rode on.
  const decided: string[] = [];
  const asked: string[] = [];
  for (const i of said) {
    const [main, ...held] = messages[i].content.split(HELD_JOINER);
    const card = answersCard(messages, i, main);
    if (card?.kind === "questions") decided.push(card.line);
    asked.push(...(card ? [] : [main]), ...held);
  }

  const replies = window.filter((m) => m.role === "assistant");
  const steps = unique(replies.flatMap((m) => m.activity.filter(shown)).map((s) => ({ label: s.label.trim(), failed: s.status === "failed" })), (s) => s.label);
  const made = unique(replies.flatMap((m) => m.artifacts), (a) => a.id).slice(0, MAX_FILES);

  // Decided on the call: on any reply here, not just the call's (a card that was on screen when it started).
  for (const m of messages) {
    for (const block of m.ui ?? []) {
      const response = m.uiResponse?.[block.id];
      if (!response || !during(response.at)) continue;
      if (block.kind === "form" && response.status === "submitted") decided.push(`Sent “${block.title}”`);
      else if (block.kind === "proposal" && response.status === "applied") decided.push(appliedText(response.applied).replace(/\.$/, ""));
      else if (block.kind === "memory-merge" && response.status === "merged") decided.push(`Merged ${response.merges.length} ${response.merges.length === 1 ? "fact" : "facts"}`);
      else if (block.kind === "browser" && response.status === "handed-back") decided.push(`Took over the browser${block.site ? ` on ${block.site}` : ""}`);
    }
    for (const a of m.approvals ?? []) {
      if (!during(a.decidedAt)) continue;
      // Decided by voice, with the member's words as they were heard.
      const said = a.decidedVia === "voice" && a.decidedWords ? ` by voice (“${a.decidedWords}”)` : "";
      if (a.status === "approved") decided.push(`Approved${said}: ${a.summary}`);
      else if (a.status === "declined") decided.push(`Declined${said}: ${a.summary}`);
    }
  }

  const out: CallRecap["out"] = [];
  if (replies.some((m) => m.status === "streaming")) out.push({ kind: "working", text: "I'm still on it" });
  // Runs it followed from here, as they stand now.
  for (const run of call.away ?? []) {
    decided.push(`Started “${run.title}”`);
    if (run.move === "working") out.push({ kind: "working", text: `I'm still on “${run.title}”` });
    else if (run.move === "your_call") out.push({ kind: "waiting", text: `Waiting on you: “${run.title}”` });
  }
  for (const m of replies) {
    for (const a of m.approvals ?? []) if (a.status === "pending" && m.status === "awaiting") out.push({ kind: "waiting", text: `Your OK: ${a.summary}` });
  }
  // A card on the call's last reply waits on them while nothing has come after it.
  const latest = replies.at(-1);
  if (latest && latest === messages.at(-1) && latest.status === "complete") {
    const open = openCard(latest);
    if (open) out.push({ kind: "waiting", text: `Waiting on you: ${open}` });
  }

  return {
    callId: call.id,
    after: messages[last].id,
    seconds: Math.max(0, Math.round((call.endedAt - call.startedAt) / 1000)),
    asked: asked.map((words) => words.trim()).filter(Boolean),
    did: steps.slice(0, MAX_STEPS),
    moreDone: Math.max(0, steps.length - MAX_STEPS),
    made,
    decided: [...new Set(decided)],
    out,
  };
}

/** The recaps of every call that's over, by the message each goes after. */
export function recapsByMessage(messages: ChatMessage[], calls: RecapCall[]): Map<string, CallRecap[]> {
  const out = new Map<string, CallRecap[]>();
  for (const call of calls) {
    const recap = callRecap(messages, call);
    if (recap) out.set(recap.after, [...(out.get(recap.after) ?? []), recap]);
  }
  return out;
}

/** A call's length in a few words: "under a minute", "4 min". */
export function callLength(seconds: number): string {
  return seconds < 60 ? "under a minute" : `${Math.round(seconds / 60)} min`;
}

/** A step worth listing: the work itself, not the agent's own books, its opening lines, or plumbing. */
function shown(step: ActivityStep): boolean {
  if (step.hidden || step.action === "note" || step.action === "remember" || step.app === "memory") return false;
  const label = step.label.trim();
  if (!label || label === PLAN_STEP_LABEL || label === PLAN_STEP_DONE_LABEL) return false;
  return step.status === "done" || step.status === "failed";
}

/**
 * Whether the member's message at `index` (its own words: `main`) is a card's answers they sent,
 * said under "decided" instead: a form's (its uiResponse says so, and is listed from there), or
 * picks on the reply's questions (listed with this line).
 */
function answersCard(messages: ChatMessage[], index: number, main: string): { kind: "form" } | { kind: "questions"; line: string } | null {
  const before = messages[index - 1];
  if (before?.role !== "assistant") return null;
  const at = messages[index].createdAt;
  const form = before.ui?.some((b) => {
    const r = before.uiResponse?.[b.id];
    return b.kind === "form" && r?.status === "submitted" && r.at <= at + 5_000 && at - r.at <= 60_000;
  });
  if (form) return { kind: "form" };
  const questions = before.questions ?? [];
  if (!isQuestionAnswer(questions, main)) return null;
  return { kind: "questions", line: questions.length === 1 ? `Answered “${questions[0].question}”` : `Answered ${questions.length} questions` };
}

/** What the reply still asks of them, in a few words. */
function openCard(message: ChatMessage): string | null {
  const ask = askOf(message);
  if (ask === "form") {
    const form = message.ui?.find((b) => b.kind === "form" && !message.uiResponse?.[b.id]);
    return form?.kind === "form" ? `“${form.title}”` : null;
  }
  if (ask === "proposal") return "the proposed setup";
  if (ask === "merge") return "facts to combine";
  if (ask === "question") return message.questions?.[0]?.question ?? null;
  return null;
}

function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

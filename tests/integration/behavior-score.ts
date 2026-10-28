import { talksMachinery } from "@/lib/agent/tools";
import type { AgentEvent } from "@/lib/agent/types";
import { buildQuestions } from "@/lib/chat/questions";
import { buildUiBlock } from "@/lib/chat/ui";
import { planFromAgent } from "@/lib/tasks/agent";
import type { Question, UiForm } from "@/lib/types";
import { replyOf } from "./setup-harness";

// Scoring for the behavior evals (behavior.eval.test.ts): one run's events read the way the member
// would see them, the checks every reply is held to, and the scorecard that compares one set of
// runs with another. Pure.

/** One run, as the member sees it. */
export interface Run {
  events: AgentEvent[];
  reply: string;
  /** The agent's lines while it worked ("Let me look…"), shown as steps, not as the reply. */
  notes: string[];
  /** Each step as it ended up (the last event for its id). */
  steps: { id: string; label: string; status: string; app?: string; action?: string; hidden?: boolean; detail?: string }[];
  questions: Question[] | null;
  forms: UiForm[];
  /** The plan as the agent last rewrote it this run, and what done means (null when it gave no goal). */
  plan: { steps: { text: string; status: string }[]; goal: string | null } | null;
  memories: { content: string; replaces: string[] }[];
  records: { collection: string; key: string; title: string; fields: Record<string, unknown> }[];
  cited: boolean;
  /** What the agent asked the member to approve (it paused there), and in which app. */
  approvals: { summary: string; app: string | null; tools: string[] }[];
  /** A task run's report_run calls (how it went: nothing_new, update, needs_you). */
  reports: { outcome: string; summary: string }[];
  /** The turns before this one in the same conversation, for cases that build up to it. */
  earlier: Run[];
  ms: number;
  /** The run failed (an AgentError or a timeout) rather than answering. */
  error?: string;
}

export function readRun(events: AgentEvent[], ms: number, error?: string): Run {
  const steps = new Map<string, Run["steps"][number]>();
  const run: Run = { events, reply: replyOf(events), notes: [], steps: [], questions: null, forms: [], plan: null, memories: [], records: [], cited: false, approvals: [], reports: [], earlier: [], ms, error };
  for (const e of events) {
    if (e.type === "note") run.notes.push(e.text);
    else if (e.type === "activity") steps.set(e.id, { id: e.id, label: e.label, status: e.status, app: e.app, action: e.action, hidden: e.hidden, detail: e.detail });
    else if (e.type === "questions") run.questions = buildQuestions(e.questions);
    else if (e.type === "ui") {
      const block = buildUiBlock(e.block);
      if (block?.kind === "form") run.forms.push(block);
    } else if (e.type === "plan-update") {
      const parsed = planFromAgent(e.plan);
      // A later update that leaves the goal out keeps the one already given, as the app does.
      const goal = typeof e.goal === "string" && e.goal.trim() ? e.goal.trim() : (run.plan?.goal ?? null);
      if (parsed) run.plan = { steps: parsed.map((s) => ({ text: s.text, status: s.status })), goal };
    } else if (e.type === "memory-proposal") run.memories.push({ content: e.content, replaces: e.replaces ?? [] });
    else if (e.type === "record") {
      const r = e.record as Record<string, unknown> | null;
      if (r && typeof r === "object") {
        const fields = r.fields && typeof r.fields === "object" ? (r.fields as Record<string, unknown>) : {};
        run.records.push({ collection: String(r.collection ?? ""), key: String(r.key ?? ""), title: String(r.title ?? r.key ?? ""), fields });
      }
    } else if (e.type === "citations") run.cited = true;
    else if (e.type === "approval") run.approvals.push({ summary: e.summary, app: e.app ?? null, tools: (e.actions ?? []).map((a) => a.tool) });
    else if (e.type === "run-report") {
      const r = e.report as Record<string, unknown> | null;
      if (r && typeof r === "object") run.reports.push({ outcome: String(r.outcome ?? ""), summary: String(r.summary ?? "") });
    }
  }
  return { ...run, steps: [...steps.values()] };
}

/** A check: null when the run passes it, else what the run did instead (for the log). */
export type Check = { name: string; test: (run: Run) => string | null };

/** Warm-up and sign-off lines that only make a reply longer. */
const FILLER = /\b(great question|good question|happy to help|hope (this|that) helps|let me know if (you|there)|feel free to (ask|reach))\b/i;
export const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const clip = (text: string, n = 120) => (text.length > n ? `${text.slice(0, n)}…` : text);

/** Steps that did work (searched, read, ran, wrote), not the ones that only report on the answer. */
export const workSteps = (run: Run) => run.steps.filter((s) => s.action !== "note");
export const searchedWeb = (run: Run) => run.steps.some((s) => s.app === "web" && s.action === "search");
export const connected = (run: Run) => run.steps.some((s) => s.action === "connect");

/** A tool slug (COMPOSIO_SEARCH_TOOLS) or a raw call (show_form(…)) is code, never words for a person. */
const SLUG = /\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b|\b[a-z]+_[a-z_]+\(/;
/**
 * A reply that ends on a go-ahead question written out ("Want me to send it?"), which belongs in
 * ask_user. Open questions (what's been hard, what you'd change) stay in text and don't match.
 */
const ASKS_IN_TEXT = /\b(want me to|shall i|should i (go ahead|start|send|draft|do)|would you like me to|do you want me to|like me to|ok(ay)? (to|if i)|sound good)\b[^?]*\?\W*$/i;
const SOURCES_LIST = /^\W*(sources|references)\W*$/im;
/** The reply points at a card ("pick one below", "I sent you a form"), which only an event can put there. */
const POINTS_AT_CARD = /\b((form|card|options?|choices?) (below|above)|pick (one|an? \w+|from the \w+) (below|above)|(sent|gave|shared) you a (form|card|few questions)|fill (in|out) the (form|card))\b/i;

/** What every reply is held to, whatever it was asked. */
export const HYGIENE: Check[] = [
  {
    name: "answers",
    test: (run) => (run.error ? `failed: ${run.error}` : run.reply.trim() || run.questions || run.forms.length ? null : "no reply, question, or card"),
  },
  {
    name: "talks about the work, not the machinery",
    test: (run) => {
      const said = [run.reply, ...run.notes, ...run.steps.filter((s) => !s.hidden).map((s) => s.label)];
      const bad = said.find((t) => talksMachinery(t) || SLUG.test(t.replace(/`[^`]*`/g, "")));
      return bad ? clip(bad) : null;
    },
  },
  {
    name: "asks a go-ahead with a card, not in text",
    test: (run) => {
      const tail = run.reply.trim().split(/\n+/).at(-1) ?? "";
      return ASKS_IN_TEXT.test(tail) ? clip(tail) : null;
    },
  },
  {
    // An answer pointing at a card that was never sent leaves the member nothing to answer, and is
    // a claim of something that didn't happen.
    name: "no card it didn't send",
    test: (run) => {
      const pointed = run.reply.match(POINTS_AT_CARD);
      return pointed && !run.questions && run.forms.length === 0 ? pointed[0] : null;
    },
  },
  {
    // The same paragraph twice is a reply written again over itself. (Drafts side by side share
    // lines, so it's whole paragraphs, outside quoted drafts, that count.)
    name: "says each thing once",
    test: (run) => {
      const paragraphs = run.reply.split(/\n\s*\n/).map((x) => x.trim().toLowerCase()).filter((x) => words(x) >= 10 && !x.startsWith(">"));
      const again = paragraphs.find((x, i) => paragraphs.indexOf(x) !== i);
      return again ? clip(again) : null;
    },
  },
  {
    // Written for a busy reader: no warm-up before the answer and no sign-off after it. Only the
    // reply's own first and last lines count, since a draft inside it may say these to its reader.
    name: "no preamble or sign-off",
    test: (run) => {
      const lines = run.reply.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith(">"));
      const hit = [lines[0] ?? "", lines.at(-1) ?? ""].join("\n").match(FILLER);
      return hit ? hit[0] : null;
    },
  },
  {
    name: "no sources list at the end",
    test: (run) => (SOURCES_LIST.test(run.reply) ? "wrote a Sources list" : null),
  },
];

// A case that builds up over turns holds every turn to the same, not just its last.
HYGIENE.push({
  name: "earlier turns hold up too",
  test: (run) => {
    for (const [i, earlier] of run.earlier.entries()) {
      for (const c of HYGIENE) {
        const miss = c.test(earlier);
        if (miss) return `turn ${i + 1}, ${c.name}: ${miss}`;
      }
    }
    return null;
  },
});

/** One case's results over its runs: per check, how many runs passed it. */
export interface CaseScore {
  id: string;
  area: string;
  runs: number;
  checks: { name: string; passed: number; misses: string[] }[];
  ms: number[];
  workSteps: number[];
  replyWords: number[];
}

export function scoreCase(id: string, area: string, checks: Check[], runs: Run[]): CaseScore {
  return {
    id,
    area,
    runs: runs.length,
    checks: checks.map((c) => {
      const misses = runs.map((r) => c.test(r)).filter((m): m is string => m !== null);
      return { name: c.name, passed: runs.length - misses.length, misses };
    }),
    ms: runs.map((r) => r.ms),
    workSteps: runs.map((r) => workSteps(r).length),
    replyWords: runs.map((r) => words(r.reply)),
  };
}

/** A check holds for the case when more than half its runs pass it. */
export const holds = (c: CaseScore["checks"][number], runs: number) => c.passed * 2 > runs;

export interface Scorecard {
  /** Checks passed over checks run, across every run of every case: the number to move. */
  score: number;
  passed: number;
  total: number;
  /**
   * Cases that passed every check on every run (τ-bench's pass^k, k being the runs a case had):
   * how often the member gets it right each time, not just once.
   */
  reliable: number;
  /** Median seconds a reply took, and mean work steps and reply words per run: the cost of the score. */
  p50s: number;
  steps: number;
  words: number;
  cases: CaseScore[];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (n: number, places = 1) => Math.round(n * 10 ** places) / 10 ** places;

export function scorecard(cases: CaseScore[]): Scorecard {
  const passed = cases.reduce((n, c) => n + c.checks.reduce((m, k) => m + k.passed, 0), 0);
  const total = cases.reduce((n, c) => n + c.checks.length * c.runs, 0);
  return {
    score: total ? round(passed / total, 3) : 0,
    passed,
    total,
    reliable: cases.length ? round(cases.filter((c) => c.checks.every((k) => k.passed === c.runs)).length / cases.length, 3) : 0,
    p50s: round(median(cases.flatMap((c) => c.ms)) / 1000),
    steps: round(mean(cases.flatMap((c) => c.workSteps))),
    words: Math.round(mean(cases.flatMap((c) => c.replyWords))),
    cases: [...cases].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

const caseRate = (c: CaseScore) => {
  const total = c.checks.length * c.runs;
  return total ? c.checks.reduce((n, k) => n + k.passed, 0) / total : 0;
};
const pct = (n: number) => `${Math.round(n * 100)}%`;
const signed = (n: number, unit = "") => `${n > 0 ? "+" : ""}${round(n)}${unit}`;

/** The scorecard as text, with each case's and check's change from a baseline scorecard when given. */
export function formatScorecard(card: Scorecard, baseline?: Scorecard): string {
  const before = new Map(baseline?.cases.map((c) => [c.id, c]));
  const vs = (now: number, then: number | undefined, unit = "", scale = 1) => (then === undefined ? "" : ` (${signed((now - then) * scale, unit)})`);
  const lines = [
    `score ${pct(card.score)} (${card.passed}/${card.total} checks)${vs(card.score, baseline?.score, " pts", 100)} · reliable ${pct(card.reliable)} of cases${vs(card.reliable, baseline?.reliable, " pts", 100)}`,
    `p50 ${card.p50s}s${vs(card.p50s, baseline?.p50s, "s")} · ${card.steps} work steps${vs(card.steps, baseline?.steps)} · ${card.words} words a reply${vs(card.words, baseline?.words)}`,
    "",
  ];
  for (const c of card.cases) {
    const then = before.get(c.id);
    lines.push(`${pct(caseRate(c)).padStart(4)}  ${c.id}${then ? vs(caseRate(c), caseRate(then), " pts", 100) : ""}  [${round(median(c.ms) / 1000)}s]`);
    for (const k of c.checks) {
      // Checks that missed now or in the baseline: ✗ fails the case, ~ holds but missed a run, ✓ fixed.
      const was = then?.checks.find((t) => t.name === k.name);
      const missedBefore = !!then && !!was && was.passed < then.runs;
      if (k.passed === c.runs && !missedBefore) continue;
      const mark = k.passed === c.runs ? "✓" : holds(k, c.runs) ? "~" : "✗";
      lines.push(`        ${mark} ${k.name}: ${k.passed}/${c.runs}${was && then ? ` (was ${was.passed}/${then.runs})` : ""}`);
      for (const m of [...new Set(k.misses)].slice(0, 2)) lines.push(`            ${m}`);
    }
  }
  return lines.join("\n");
}

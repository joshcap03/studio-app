import { PLAN_STEP_LABEL } from "@/lib/agent/tools";
import type { AgentEvent } from "@/lib/agent/types";
import { buildQuestions } from "@/lib/chat/questions";
import { buildUiBlock } from "@/lib/chat/ui";
import type { ChatMessage, UiBlock } from "@/lib/types";
import { plain, relayReply } from "@/lib/voice/relay";
import type { Turn } from "./setup-harness";

// How conversational a turn would be on a live call, scored from what the voice would actually
// say (relayReply: the reply's gist, its closing question, and each card's line) and when it could
// start saying it (the call reads the reply once the agent moves on to its next step, see
// call.tsx). Text only: no audio, no voice minutes. Pure.

export interface CallTurnScore {
  /** The reply opens with a greeting the voice already said. */
  greeted: boolean;
  /** What the voice would say for this turn. */
  spoken: string;
  spokenWords: number;
  /** Questions the reply itself asks (a card or quick pick aside). One at a time is a conversation. */
  questions: number;
  /** The turn ends handing them the floor: a question said last, or a card or quick pick to answer. */
  handsBack: boolean;
  /** The reply ran past what the voice says, and the rest was left on screen. */
  restOnScreen: boolean;
  /** Seconds until the voice could start on the reply. */
  answerS: number;
  /** The agent kept its books (plan, memory) before writing a word of its reply. */
  booksFirst: boolean;
}

const SENTENCES = /[^.!?]+[.!?]+["”’)]*|[^.!?]+$/g;
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

function bookkeeping(e: AgentEvent): boolean {
  return (
    e.type === "plan-update" ||
    e.type === "memory-proposal" ||
    (e.type === "activity" && (e.action === "remember" || e.app === "memory" || e.label.trim() === PLAN_STEP_LABEL))
  );
}

export function scoreCallTurn(turn: Pick<Turn, "events" | "eventMs" | "reply" | "ms">): CallTurnScore {
  const { events, eventMs } = turn;
  const ui: UiBlock[] = [];
  let questions: ChatMessage["questions"] = null;
  for (const e of events) {
    if (e.type === "ui") {
      const block = buildUiBlock(e.block);
      if (block) ui.push(block);
    } else if (e.type === "questions") questions = buildQuestions(e.questions);
  }
  const lines = relayReply({ content: turn.reply, status: "done", questions, ui } as unknown as ChatMessage);
  const spoken = lines.map((l) => l.text).join(" ");

  // As the call does: the reply is read at the first step after its text started, or at the end.
  let text = "";
  let answerMs = turn.ms;
  let booksFirst = false;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === "text-delta") text += e.text;
    else if (!text.trim() && bookkeeping(e)) booksFirst = true;
    else if (e.type === "activity" && text.trim()) {
      answerMs = eventMs[i] ?? turn.ms;
      break;
    }
  }

  const prose = plain(turn.reply);
  return {
    greeted: /^(hey|hi|hello)\b/i.test(turn.reply.trimStart()),
    spoken,
    spokenWords: words(spoken),
    questions: (prose.match(SENTENCES) ?? []).filter((s) => /\?["”’)]*$/.test(s.trim())).length,
    handsBack: Boolean(questions?.length || ui.length || /\?["”’)]*$/.test(spoken.trim())),
    restOnScreen: spoken.includes("The rest is on screen."),
    answerS: Math.round(answerMs / 100) / 10,
    booksFirst,
  };
}

function pct(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** One line for a set of turns: the call's conversational scorecard. */
export function callSummary(scores: CallTurnScore[]): string {
  const n = scores.length;
  const count = (f: (s: CallTurnScore) => boolean) => `${scores.filter(f).length}/${n}`;
  const spoken = scores.map((s) => s.spokenWords);
  const answers = scores.map((s) => s.answerS);
  return [
    `${n} turns`,
    `spoken words p50 ${pct(spoken, 50)}, p90 ${pct(spoken, 90)}`,
    `one question or none ${count((s) => s.questions <= 1)}`,
    `hands back ${count((s) => s.handsBack)}`,
    `rest on screen ${count((s) => s.restOnScreen)}`,
    `reply starts p50 ${pct(answers, 50)}s, p90 ${pct(answers, 90)}s`,
    `books before reply ${count((s) => s.booksFirst)}`,
    `greeted ${count((s) => s.greeted)}`,
  ].join(" · ");
}

import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { callSummary, scoreCallTurn, type CallTurnScore } from "./call-score";
import { describeTurn, liveFlow, setupSession, type ScriptedMember } from "./setup-harness";

// How conversational the agent is on a live call, against a live flow with a real model
// (LANGFLOW_TEST_* env; see setup-harness.ts). Made-up callers start a setup interview on a call,
// their words as speech-to-text gives them (fillers, slips, little punctuation): one rambles, one
// answers in a few words, one changes their mind mid-answer. Each turn is scored from what the
// voice would say (call-score.ts), with no audio and no voice minutes. The checks hold only the
// call's plain rules; the scorecard printed at the end (and written beside SETUP_EVAL_LOG, with
// each turn's scores) is the number to compare prompt changes by, over several runs, since one
// run is noisy.

const ADVICE = /\b(recommend|suggest|i'd start|start with|help (you )?most|where i (can|could) help|here's my read|i think i (can|could)|i'd leave)\b/i;
const TURNS = 6;

const RAMBLER: ScriptedMember = {
  id: "call.rambler",
  modality: "call",
  templateId: "job-search",
  agentName: "Job search",
  name: "Alex",
  discovery: [
    "um yeah so i'm a backend engineer i've been at the same place like six years and it's fine but i kind of want something new this year maybe a smaller company i don't know",
    "honestly the hard part is i open linkedin and there's like four hundred postings and half of them are senior but then they want ten years of kubernetes or they're actually contract and i just close the tab",
    "i tried saved searches and some newsletter but i stopped opening them after a week",
    "i guess if it worked i'd only look at like five roles a week and they'd all be ones i'd actually apply to",
    "oh and don't email anybody for me i want to do that part myself",
  ],
  advice: ADVICE,
  agree: "yeah that sounds right let's start with finding the good roles",
  bar: [],
  passReason: "contract not full time",
};

const TERSE: ScriptedMember = {
  id: "call.terse",
  modality: "call",
  templateId: "small-business",
  agentName: "Shop",
  name: "Jordan",
  discovery: ["candle shop online", "too many emails", "wholesale orders mostly", "spreadsheet", "fewer missed orders"],
  advice: ADVICE,
  agree: "yes",
  bar: [],
  passReason: "too formal",
  text: () => "fine",
};

const CHANGER: ScriptedMember = {
  id: "call.changer",
  modality: "call",
  templateId: "job-search",
  agentName: "Job search",
  name: "Casey",
  discovery: [
    "i'm a marketing manager looking for director roles",
    "actually wait scratch that i'd take a senior manager role too if the company's right it's more about the company than the title",
    "mostly i don't know which companies are worth it i keep applying to ones that turn out to be a mess",
    "actually the bigger thing is i never hear back so maybe it's my resume i don't know",
    "i'd want to hear back from like half the places i apply to",
  ],
  advice: ADVICE,
  agree: "hmm actually yes but let's do the company part first",
  bar: [],
  passReason: "company in layoffs",
};

const all: { id: string; scores: CallTurnScore[] }[] = [];

afterAll(() => {
  if (!all.length) return;
  const card = [...all.map(({ id, scores }) => `${id}: ${callSummary(scores)}`), `all calls: ${callSummary(all.flatMap((x) => x.scores))}`];
  for (const line of card) console.log(line);
  // Vitest may drop console output from a run that passes, so the scorecard is also kept.
  const log = process.env.SETUP_EVAL_LOG;
  if (log) writeFileSync(log.replace(/(\.json)?$/, ".scorecard.txt"), `${card.join("\n")}\n`);
});

describe.skipIf(!liveFlow)("A setup interview on a call, against a live flow", () => {
  for (const member of [RAMBLER, TERSE, CHANGER]) {
    describe(member.id!, () => {
      const session = setupSession(member);
      const { turns } = session;
      const scores: CallTurnScore[] = [];

      afterAll(() => {
        session.writeLog(`setup on a call (${member.id})`);
        all.push({ id: member.id!, scores });
        const log = process.env.SETUP_EVAL_LOG;
        if (log) writeFileSync(log.replace(/(\.json)?$/, `.${member.id}.scores.json`), JSON.stringify(scores, null, 2));
      });

      // A greeting is on the scorecard, not checked here: the voice drops it before speaking.
      it("talks like a call: one thing asked at a time, and the floor handed back", { timeout: 1_200_000 }, async () => {
        let last = await session.start();
        for (let i = 1; i < TURNS && !last.proposal; i++) last = await session.answer(last);
        scores.push(...turns.map(scoreCallTurn));
        const said = (i: number) => `#${i} ${describeTurn(turns[i])}\nsaid: ${scores[i].spoken}`;
        // A question at a time ("this, or that?" can count as two).
        expect(scores.flatMap((s, i) => (s.questions > 2 ? [said(i)] : [])), "asked too much at once").toEqual([]);
        // A turn that doesn't hand back the floor leaves them on a silent line.
        expect(scores.flatMap((s, i) => (s.handsBack ? [] : [said(i)])), "left them on a silent line").toEqual([]);
      });
    });
  }
});

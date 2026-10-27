import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { baseContext, CASES } from "./behavior-cases";
import { RUN_TIMEOUT, runCase, slots, transcript } from "./behavior-harness";
import { formatScorecard, HYGIENE, holds, scoreCase, scorecard, type CaseScore, type Scorecard } from "./behavior-score";
import { liveFlow } from "./setup-harness";

// How the agent behaves on long-horizon work (a task's runs, a project over several turns) and on
// the everyday things its instructions ask of it, on a live flow with a real model (LANGFLOW_TEST_*
// env; point it at a test flow, never the live one). Each case (behavior-cases.ts) goes to a
// made-up owner's agent and is checked against what the member would see, plus the checks every
// reply is held to (HYGIENE). It's the set to tune the instructions by:
//
//   BEHAVIOR_EVAL_RUNS=3            runs each case 3 times (default 1); a check holds for a case when
//                                   more than half its runs pass it, and "reliable" counts the cases
//                                   that passed everything every time.
//   BEHAVIOR_EVAL_LOG=<path>        writes each run's transcript (<path>) and the scorecard
//                                   (<path>.scorecard.txt, and .json to compare against later).
//   BEHAVIOR_EVAL_BASELINE=<path>   a scorecard .json from an earlier run, to print the change.
//   BEHAVIOR_EVAL_CONCURRENCY=4     runs at once against the flow (default 4).
//   -t "<area>"                     just one area's cases, e.g. -t "task".
//
// One run is noisy: judge a change over several runs, and read the transcript before rewording
// the instructions for a miss. Connected apps have their own set (connectors.eval.test.ts).

const RUNS = Math.max(1, Number(process.env.BEHAVIOR_EVAL_RUNS ?? 1));
const CONCURRENCY = Math.max(1, Number(process.env.BEHAVIOR_EVAL_CONCURRENCY ?? 4));
const slot = slots(CONCURRENCY);

const scores: CaseScore[] = [];
const transcripts: unknown[] = [];

describe.skipIf(!liveFlow)("the agent's everyday behavior on a live flow", () => {
  afterAll(() => {
    if (scores.length === 0) return;
    const card = scorecard(scores);
    const baselinePath = process.env.BEHAVIOR_EVAL_BASELINE;
    const baseline = baselinePath ? (JSON.parse(readFileSync(baselinePath, "utf8")) as Scorecard) : undefined;
    const text = formatScorecard(card, baseline);
    console.log(`\n${text}\n`);
    const log = process.env.BEHAVIOR_EVAL_LOG;
    if (!log) return;
    writeFileSync(log, JSON.stringify(transcripts, null, 2));
    writeFileSync(`${log}.scorecard.txt`, `${text}\n`);
    writeFileSync(`${log}.scorecard.json`, JSON.stringify(card, null, 2));
  });

  it.concurrent.each(CASES.map((c) => [c.id, c] as const))(
    "%s",
    async (_, c) => {
      const runs = await Promise.all(Array.from({ length: RUNS }, () => slot(() => runCase(c, baseContext()))));
      const checks = [...HYGIENE, ...c.checks];
      const score = scoreCase(c.id, c.id.split(".")[0], checks, runs);
      scores.push(score);
      runs.forEach((r, i) => transcripts.push(transcript(c, r, i, checks)));
      const failing = score.checks.filter((k) => !holds(k, score.runs)).map((k) => `${k.name} (${k.passed}/${score.runs}): ${k.misses[0]}`);
      expect(failing, `${c.says}\n${failing.join("\n")}`).toEqual([]);
    },
    RUN_TIMEOUT * Math.ceil((RUNS * CASES.length) / CONCURRENCY) + 60_000,
  );
});

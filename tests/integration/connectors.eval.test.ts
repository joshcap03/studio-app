import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { RUN_TIMEOUT, runCase, slots, transcript } from "./behavior-harness";
import { formatScorecard, HYGIENE, holds, readRun, scoreCase, scorecard, type CaseScore, type Run } from "./behavior-score";
import { appSteps, CONNECTED, CONNECTOR_CASES, connectedContext } from "./connector-cases";
import { barSent, describeTurn, liveFlow, setupSession, type ScriptedMember, type Turn } from "./setup-harness";

// How the agent works in connected apps, on a live flow with a real model (LANGFLOW_TEST_* env;
// point it at a test flow, never the live one), for a test member whose throwaway accounts are
// connected: each template's everyday work on its apps (connector-cases.ts), and the setup
// interview run to its trial with the inbox connected, so the trial reads the real inbox.
//
//   CONNECTORS_EVAL_USER=<id>       the test member's Composio user id (lj_ and 32 hex, as the flow
//                                   requires), with test accounts connected in the flow's Composio
//                                   project. Never a real person's.
//   CONNECTORS_EVAL_APPS=gmail,calendar,sheets   the apps connected there (the default); cases
//                                   needing others are skipped.
//   CONNECTORS_EVAL_CONNECT=1       instead prints links to connect those apps for that user (open
//                                   them signed in to the test accounts), then stops.
//   CONNECTORS_EVAL_RUNS, CONNECTORS_EVAL_LOG, CONNECTORS_EVAL_CONCURRENCY: as the behavior evals'.
//
// Writes wait for approval and the evals never approve, so nothing is sent or changed in the test
// accounts. The scorecard adds a line per app: its steps, how many failed, and approvals asked.

const USER = process.env.CONNECTORS_EVAL_USER?.trim();
const APPS = (process.env.CONNECTORS_EVAL_APPS ?? "gmail,calendar,sheets").split(",").map((a) => a.trim()).filter(Boolean);
const RUNS = Math.max(1, Number(process.env.CONNECTORS_EVAL_RUNS ?? 1));
const CONCURRENCY = Math.max(1, Number(process.env.CONNECTORS_EVAL_CONCURRENCY ?? 3));
const CONNECT = process.env.CONNECTORS_EVAL_CONNECT === "1";
const enabled = liveFlow && Boolean(USER);
// Member Apps takes only a member-shaped id (see memberAppsId), so any other gets no app tools.
if (USER && !/^lj_[0-9a-f]{32}$/.test(USER)) throw new Error("CONNECTORS_EVAL_USER must look like a member's Composio id: lj_ and 32 hex characters.");
const slot = slots(CONCURRENCY);

const cases = CONNECTOR_CASES.filter((c) => c.apps.every((a) => APPS.includes(a)));
const scores: CaseScore[] = [];
const runsByApp = new Map<string, Run[]>();
const transcripts: unknown[] = [];

/** Per app: its steps across every run, how many failed, approvals it asked for, and median case time. */
function appLines(): string[] {
  return [...runsByApp.entries()].map(([app, runs]) => {
    const steps = runs.flatMap((r) => appSteps(r, app));
    const failed = steps.filter((s) => s.status === "failed").length;
    const approvals = runs.reduce((n, r) => n + r.approvals.filter((a) => a.app === app).length, 0);
    const ms = runs.map((r) => r.ms).sort((a, b) => a - b);
    return `${app.padEnd(9)} ${steps.length} steps, ${failed} failed (${steps.length ? Math.round((failed / steps.length) * 100) : 0}%), ${approvals} approvals asked, p50 ${Math.round((ms[Math.floor(ms.length / 2)] ?? 0) / 100) / 10}s over ${runs.length} runs`;
  });
}

describe.skipIf(!enabled || !CONNECT)("connecting the connector evals' test account", () => {
  it("prints links to connect its apps", async () => {
    const run = await runCase(
      { id: "connect", says: "", message: `connect my ${APPS.join(", ")} please. just give me the links`, checks: [] },
      connectedContext("blank", USER!),
    );
    // The link comes in the reply, or on a connect step's result.
    const links = [...new Set(JSON.stringify(run.events).match(/https:\/\/[^\s"\\)]*(connect|auth|oauth|link)[^\s"\\)]*/gi) ?? [])];
    console.log(`\nOpen these signed in to the test accounts:\n${links.join("\n") || run.reply || run.error || JSON.stringify(run.events.filter((e) => e.type !== "text-delta" && e.type !== "evidence"))}\n`);
    expect(links.length).toBeGreaterThan(0);
  }, RUN_TIMEOUT);
});

describe.skipIf(!enabled || CONNECT)("each template's work in connected apps, on a live flow", () => {
  afterAll(() => {
    if (scores.length === 0) return;
    const text = [formatScorecard(scorecard(scores)), "", ...appLines()].join("\n");
    console.log(`\n${text}\n`);
    const log = process.env.CONNECTORS_EVAL_LOG;
    if (!log) return;
    writeFileSync(log, JSON.stringify(transcripts, null, 2));
    writeFileSync(`${log}.scorecard.txt`, `${text}\n`);
    writeFileSync(`${log}.scorecard.json`, JSON.stringify(scorecard(scores), null, 2));
  });

  it.concurrent.each(cases.map((c) => [c.id, c] as const))(
    "%s",
    async (_, c) => {
      const runs = await Promise.all(Array.from({ length: RUNS }, () => slot(() => runCase(c, connectedContext(c.templateId, USER!)))));
      const checks = [...HYGIENE, ...CONNECTED(c.apps), ...c.checks];
      const score = scoreCase(c.id, c.templateId, checks, runs);
      scores.push(score);
      for (const app of c.apps) runsByApp.set(app, [...(runsByApp.get(app) ?? []), ...runs]);
      runs.forEach((r, i) => transcripts.push(transcript(c, r, i, checks)));
      const failing = score.checks.filter((k) => !holds(k, score.runs)).map((k) => `${k.name} (${k.passed}/${score.runs}): ${k.misses[0]}`);
      expect(failing, `${c.says}\n${failing.join("\n")}`).toEqual([]);
    },
    RUN_TIMEOUT * Math.ceil((RUNS * cases.length) / CONCURRENCY) + 60_000,
  );
});

// The Inbox & calendar setup interview, with their inbox already connected: its trial run reads
// the real inbox, and it never asks them to connect what's connected or paste what it can read.
// Made up: the member, their work, and their answers. The inbox is the test account's.

const AGREE = "Yes, start with catching what needs me each morning. Drafting replies would be a bonus.";
let seen: Turn[] = [];
const agreed = () => seen.some((x) => x.message === AGREE);

const CONNECTED_MANAGER: ScriptedMember = {
  id: "connected",
  templateId: "inbox-calendar",
  agentName: "Inbox",
  name: "Sam",
  discovery: [
    "I run a small design studio. My Gmail is already connected here.",
    "My inbox is a mess: client emails get buried under newsletters and notifications.",
    "Last month I missed a client asking to move a deadline. That's what I'm scared of.",
    "Filters miss things, and I stop starring when it gets busy.",
    "Every morning I'd know which emails need me today.",
  ],
  advice: /\b(recommend|suggest|i'd start|start with|help (you )?most|where i (can|could) help|here's my read|i think i (can|could)|i'd leave)\b/i,
  agree: AGREE,
  bar: [
    [/one thing|most want/i, "Never miss an email that needs me"],
    [/great|judge|success/i, "By 9am each weekday, every email that needs me today, with one line on what they want"],
    [/\bstop\b|\bdeal|hate|wrong|break|never/i, "Missing one that needs me, or newsletters on the list"],
  ],
  passReason: "A newsletter, not a person",
  text: (label) => (/\b(hours?|when)\b/i.test(label) ? "9 to 6 on weekdays." : /\bhow many\b|\bat most\b/i.test(label) ? "10 at most." : undefined),
  // Asked to connect or paste their email, they say it's connected.
  reply: (agentText) =>
    agreed() && !barSent(seen) && /\b(connect|paste|share|forward|send)\b[^?]*\b(gmail|email|inbox|emails|messages)\b[^?]*\?/i.test(agentText)
      ? "My Gmail is already connected, use that."
      : undefined,
};

const isTrial = (x: Turn) => x.form?.fields.some((f) => f.kind === "verdict" && f.items.length >= 1) ?? false;

describe.skipIf(!enabled || CONNECT || !APPS.includes("gmail"))("Inbox & calendar setup with the inbox connected, to the trial run", () => {
  const session = setupSession(CONNECTED_MANAGER);
  session.tenant.composioUserId = USER ?? "";
  seen = session.turns;
  afterAll(() => session.writeLog("inbox & calendar setup, connected"));

  it("runs the trial on the real inbox, without asking to connect it, changing nothing", { timeout: 1_200_000 }, async () => {
    let last = await session.start();
    for (let i = 0; i < 14 && !isTrial(last) && !last.proposal; i++) last = await session.answer(last);
    const turns = session.turns;
    const trial = turns.findIndex(isTrial);
    expect(trial, turns.map(describeTurn).join("\n---\n")).toBeGreaterThan(0);
    const runs = turns.slice(0, trial + 1).map((t) => readRun(t.events, t.ms));
    runsByApp.set("gmail", [...(runsByApp.get("gmail") ?? []), ...runs]);
    // It read the inbox for the trial, and its Gmail steps went through.
    const gmail = runs.flatMap((r) => appSteps(r, "gmail"));
    expect(gmail.length, "the trial didn't read Gmail").toBeGreaterThan(0);
    expect(gmail.filter((s) => s.status === "failed").map((s) => s.label)).toEqual([]);
    // Connected already: no connect card for it, and no asking them to paste emails.
    const connectCard = turns.slice(0, trial + 1).some((t) => t.form?.fields.some((f) => f.kind === "connect" && f.apps.some((a) => /gmail/i.test(a))));
    expect(connectCard, "showed a card to connect Gmail, which is connected").toBe(false);
    expect(turns.slice(0, trial + 1).some((t) => /\bpaste\b/i.test(t.reply)), "asked them to paste emails it can read").toBe(false);
    // The trial changes nothing: no approvals, no writes outside their own notes.
    const events = turns.flatMap((t) => t.events);
    expect(events.filter((e) => e.type === "approval")).toEqual([]);
    expect(events.filter((e) => e.type === "activity" && e.action === "write" && e.status === "done" && !["tracker", "memory"].includes(e.app ?? ""))).toEqual([]);
  });
});

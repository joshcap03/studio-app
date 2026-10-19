import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { barSent, carriesRankedBar, checklistGrowth, describeTurn, liveFlow, setupSession, writesPlan, type ScriptedMember, type Turn } from "./setup-harness";

// Eval of the Small business setup interview against a live flow with a real model
// (LANGFLOW_TEST_* env; see setup-harness.ts), for an owner who doesn't know yet what they need:
// they name pains, not jobs, and their invoices live in an app that isn't connected. A second,
// shorter run gives the same owner a personal guardrail against being told what to do, which
// outranks the setup's advice. The bakery is made up.

const ADVICE = /\b(recommend|suggest|i'd start|start with|help (you )?most|where i (can|could) help|here's my read|i think i (can|could)|i'd leave)\b/i;

/** The unpaid invoices, as the owner would paste them when asked (they keep them in a sheet). */
const INVOICES = "Corner Café, #1042, $840, due Sep 30\nBlue Door Coffee, #1047, $560, due Oct 3\nMill Street Café, #1051, $1,120, due Oct 5";
/** Where they keep them: a sheet they'd rather not connect yet, so they paste the rows instead. */
const WHERE = `In a Google Sheet. I'd rather not connect it yet, so here are the unpaid ones:\n${INVOICES}`;
const NO_LINK = "I'd rather not connect or share the sheet yet. Please use the rows I pasted.";
const ASKS_WHERE = /\bwhere (?:do )?(?:you )?(?:keep|store|track)\b|\bwhere (?:do )?(?:your |the )?invoices live\b|\bwhich (?:app|one) (?:do you|is it)\b/i;

/** The turns so far, for the owner to tell the agent's plan from discovery's advice. */
let seen: Turn[] = [];
/** What the owner knows that the agent doesn't, given once when it runs its plan by them. */
const PLAN_ADVICE = "Mostly right. Mill Street only ever answers WhatsApp, so draft theirs as a short text, not an email.";
const FROM_PLAN_ADVICE = /whatsapp|text message|as a text/i;
let advised = false;

const OWNER: ScriptedMember = {
  templateId: "small-business",
  agentName: "Bakery",
  name: "Robin",
  discovery: [
    "I run a small bakery. We sell wholesale bread to a few cafés and do a weekend market stall.",
    "Honestly I'm drowning. Instagram DMs all day, wholesale invoices nobody's paid, and I keep forgetting to reorder flour.",
    "The invoices keep me up at night. Three cafés owe me for last month and chasing them feels awkward.",
    "I've tried a spreadsheet and reminders on my phone. I stop checking them when it gets busy.",
    "I'd get paid on time without having to be the bad guy, and have my evenings back.",
  ],
  advice: ADVICE,
  agree: "Yes, start with the unpaid invoices. The DMs can wait.",
  bar: [
    [/one thing|most want/i, "Get my wholesale invoices paid on time"],
    [/great|judge|good/i, "Every unpaid invoice gets a friendly reminder drafted by Monday 9am, and nothing goes out without me"],
    [/stop using|deal|hate|wrong/i, "Reminders that sound pushy or mention late fees"],
  ],
  passReason: "Too pushy for a regular",
  text: (label) =>
    ASKS_WHERE.test(label)
      ? WHERE
      : /\b(link|url)\b/i.test(label)
        ? NO_LINK
        : /\b(invoices?|rows|sheet|paste)\b/i.test(label)
          ? INVOICES
          : /\b(tone|talk|voice|sound)\b/i.test(label)
        ? "Warm and casual, first names."
        : /\b(sell|business|customers|buy)\b/i.test(label)
          ? "Wholesale sourdough and pastries to four cafés, plus a weekend market stall."
          : /\bbreak/i.test(label)
            ? "Late fees, anything pushy"
            : undefined,
  // Asked in plain words where the invoices are, or to share them, they say and paste them.
  reply: (agentText) =>
    !advised && barSent(seen) && writesPlan(agentText)
      ? ((advised = true), PLAN_ADVICE)
      : barSent(seen) && /\bcontacts?\b[^?]*\?/i.test(agentText)
        ? "Leave the contacts out for now. I'll add them when I send."
        : ASKS_WHERE.test(agentText)
      ? WHERE
      : /\b(paste|type)\b[^.?!]*\b(invoices?|rows)\b/i.test(agentText) && /\?|\bhere\b|\bbelow\b/i.test(agentText)
        ? INVOICES
        : /\b(sheet )?link\b/i.test(agentText) && /\?|\bsend\b/i.test(agentText)
          ? NO_LINK
          : undefined,
};

const FROM_BAR = /monday|9 ?am|friendly|pushy|late fee/i;
/** Saying what it can't reach yet: their invoices are in an app that isn't connected. */
const MISSING_APP =
  /\b(?:(?:isn't|is not|aren't|are not|not)(?: yet)? connected|no (?:\w+ ){0,3}(?:apps?|sheets?|accounts?|tools?) (?:is |are )?(?:yet )?(?:connected|linked)|(?:once|until) [^.]{0,40}\bconnect|connect (?:it|them|quickbooks|google sheets|your)|(?:can't|cannot|couldn't) (?:see|reach|read|access)|no access|don't have access|without access)/i;
const plain = (s: string) => s.replace(/[‘’]/g, "'");

const isTrial = (x: Turn) => x.form?.fields.some((f) => f.kind === "verdict" && f.items.length >= 2) ?? false;

describe.skipIf(!liveFlow)("Small business setup interview against a live flow", () => {
  const session = setupSession(OWNER);
  const { turns, answer } = session;
  beforeAll(() => {
    seen = turns;
  });

  afterAll(() => session.writeLog("small business setup"));

  it("opens with a greeting and an open question, not a form", { timeout: 300_000 }, async () => {
    const first = await session.start();
    expect(first.form, describeTurn(first)).toBeNull();
    expect(first.reply, describeTurn(first)).toContain("?");
    expect(first.reply.trimStart(), describeTurn(first)).toMatch(/^Hey\b/);
  });

  it("works out where they need help, and advises where to start, before any form", { timeout: 900_000 }, async () => {
    let last = session.last();
    for (let i = 0; i < 9 && !last.form; i++) last = await answer(last);
    const firstForm = turns.findIndex((x) => x.form);
    expect(firstForm, turns.map(describeTurn).join("\n---\n")).toBeGreaterThanOrEqual(2);
    const talked = turns.slice(0, firstForm);
    for (const x of talked) expect(x.reply, describeTurn(x)).toContain("?");
    expect(talked.filter((x) => x.events.some((e) => e.type === "questions")).length, "discovery asked through menus").toBeLessThanOrEqual(1);
    expect(talked.slice(1).some((x) => ADVICE.test(x.reply)), "no advice before the first form").toBe(true);
  });

  it("asks for what a real trial needs, or says plainly what it can't see, before judging results", { timeout: 900_000 }, async () => {
    let last = session.last();
    for (let i = 0; i < 6 && !isTrial(last) && !last.proposal; i++) last = await answer(last);
    const trial = turns.findIndex(isTrial);
    // From the first question on: it may well ask where the invoices are while still in discovery.
    const before = turns.slice(1, trial === -1 ? undefined : trial + 1);
    const offered = before.some((x) => x.form?.fields.some((f) => f.kind === "connect"));
    const asked = before.some((x) => [x.reply, ...(x.form?.fields.map((f) => f.label) ?? [])].some((text) => ASKS_WHERE.test(plain(text))));
    const said = before.some((x) => [x.reply, x.form?.intro ?? ""].some((text) => MISSING_APP.test(plain(text)) || /\bpaste\b/i.test(text)));
    expect(offered || asked || said, before.map(describeTurn).join("\n---\n")).toBe(true);
  });

  it("ends with a proposal held to their bar, honest about what's missing", { timeout: 900_000 }, async () => {
    let last = session.last();
    for (let i = 0; i < 12 && !last.proposal; i++) last = await answer(last);
    expect(last.proposal, describeTurn(last)).not.toBeNull();
    const instructions = last.proposal!.instructions ?? "";
    expect(instructions, "the proposal doesn't say what success means").toMatch(/what success means/i);
    // Built on the plan they talked through, with their advice in it.
    expect(advised, "it never wrote out its plan for the owner's advice").toBe(true);
    expect(instructions, "the proposal has no plan").toMatch(/how i'll do it/i);
    expect(instructions, "the plan dropped the owner's advice").toMatch(FROM_PLAN_ADVICE);
    expect(FROM_BAR.test(instructions) || carriesRankedBar(turns, instructions), `the proposal dropped the owner's bar: ${instructions.slice(0, 400)}`).toBe(true);
    // Their invoices were never connected, so it can't promise to chase them unseen.
    expect(`${last.reply}\n${instructions}`, "the proposal hides that it can't see their invoices yet").toSatisfy((text: string) => MISSING_APP.test(plain(text)));
    expect(last.reply).not.toMatch(/\b(you're|you are|you're all|we're|i'm|i am) (all )?set up\b/i);
  });

  it("lists only what it knows: three steps to start, and nothing past the bar until it's confirmed", () => {
    const growth = checklistGrowth(turns);
    expect(growth.first, "no checklist on the first reply").not.toBeNull();
    expect(growth.first!, "the first checklist laid out the whole setup").toBeLessThanOrEqual(3);
    expect(growth.early, "the checklist listed later setup before the bar was confirmed").toEqual([]);
  });

  it("changes nothing outside the owner's own notes before Apply", () => {
    expect(turns.length).toBeGreaterThan(1);
    const events = turns.flatMap((x) => x.events);
    expect(events.filter((e) => e.type === "approval")).toEqual([]);
    const wrote = events.filter(
      (e) => e.type === "activity" && e.action === "write" && e.status === "done" && !["tracker", "memory"].includes(e.app ?? ""),
    );
    expect(wrote).toEqual([]);
  });
});

/** Recommending or deciding for them, which their guardrail rules out. */
const DECIDES =
  /\b(?:(?<!\bbefore )i(?:'d| would)? (?:recommend|suggest)|my (?:recommendation|pick|suggestion)|i'd (?:start|go|pick|focus)|you should (?:start|do|go|pick|focus|tackle)|your (?:call|decision)|up to you|the best (?:option|choice|place to start) is)\b/i;

describe.skipIf(!liveFlow)("Small business setup under a guardrail against being told what to do", () => {
  const session = setupSession({
    ...OWNER,
    guardrail: "Don't make decisions for me or tell me what I should do. Lay out the options and their tradeoffs, and let me choose.",
    advice: /\b(options?|either|ways? (i|we) could|where i (can|could) help|tradeoffs?)\b/i,
    agree: "Let's do the unpaid invoices first.",
  });
  const { turns, answer } = session;
  beforeAll(() => {
    seen = turns;
  });

  afterAll(() => session.writeLog("small business setup, guardrail"));

  it("lays out where it could help without recommending, before any form", { timeout: 900_000 }, async () => {
    let last = await session.start();
    for (let i = 0; i < 9 && !last.form; i++) last = await answer(last);
    const firstForm = turns.findIndex((x) => x.form);
    const talked = firstForm === -1 ? turns : turns.slice(0, firstForm);
    for (const x of talked) expect(x.reply.replace(/[\u2018\u2019]/g, "'"), describeTurn(x)).not.toMatch(DECIDES);
    // It still says where it could help: two or more options, not silence.
    const helps = /\b(i|we) (could|can) help\b|\b(i|we) could\b|\boptions?\b|\btrade-?offs?\b|\bways?\b/i;
    const options = (reply: string) => helps.test(reply) && ((reply.match(/^\s*(?:[-*•]|\d+[.)])\s+/gm) ?? []).length >= 2 || /\bor\b/i.test(reply));
    expect(talked.slice(1).some((x) => options(x.reply)), talked.map(describeTurn).join("\n---\n")).toBe(true);
  });
});

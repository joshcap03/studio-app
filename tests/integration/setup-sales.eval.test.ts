import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scheduleFrom } from "@/lib/chat/ui";
import { taskScheduleSchema } from "@/lib/tasks/schedule";
import type { UiForm } from "@/lib/types";
import { barSent, carriesRankedBar, checklistGrowth, describeTurn, liveFlow, setupSession, writesPlan, type ScriptedMember, type Turn } from "./setup-harness";

// Eval of the Sales pipeline setup interview against a live flow with a real model
// (LANGFLOW_TEST_* env; see setup-harness.ts), for the owner of a small B2B business who wants
// more customers and doesn't know yet how they want help. Discovery leaves out who buys from
// them, so the "What you sell" step has something to learn before the trial run looks for leads.
// The print shop is made up.

const ADVICE = /\b(recommend|suggest|i'd start|start with|help (you )?most|where i (can|could) help|here's my read|i think i (can|could)|i'd leave)\b/i;

/** What they sell, and who buys it, as the owner would put it when asked. */
const PRODUCT = "Custom printed labels for beer cans, bottles, and coffee bags. Short runs from 500 labels, delivered in 5-7 days, about 20 cents a label.";
const BUYERS =
  "Independent craft breweries with a taproom, 5-50 staff, that put out a new seasonal beer every month or so; a few small coffee roasters too. Oregon and Washington to start.";

/** The turns so far, for the owner to tell discovery from the steps after it. */
let seen: Turn[] = [];
/** What the owner knows that the agent doesn't, given once when it runs its plan by them. */
const PLAN_ADVICE =
  "Mostly right. Head brewers never read cold email, so reach the taproom or marketing manager instead. And lead with our 5-day turnaround on seasonal runs; that's what wins people over.";
const FROM_PLAN_ADVICE = /taproom|marketing manager|5[- ]day|five[- ]day/i;
let advised = false;

const AGREE = "Yes, start with finding the right businesses and the person to talk to at each. I'd want to see any first email before it goes out.";
const agreed = () => seen.some((x) => x.message === AGREE);
/** Asked who their customers are while still in discovery: they haven't really looked. */
const VAGUE = "All sorts, honestly: whoever finds us. I've never sat down and worked out who the best ones are.";
/** Pressed again in discovery: a rough memory, still not who the best ones are. */
const ROUGH = "Off the top of my head, a couple of breweries and a coffee place recently, but I'd have to look.";
/** Asking who buys from them, who their best customers are, or about their last few orders. */
const ASKS_BUYERS =
  /\b(who|what kinds? of|which)\b[^?]{0,60}\b(buys?|buyers?|customers?|clients?|orders?)\b[^?]*\?|\b(name|list|tell me about|think of)\b[^?.]{0,80}\b(customers?|clients?|orders?)\b/i;
const ASKS_PRODUCT = /\bwhat (?:exactly )?(?:do you|you) (?:sell|make|print|offer)\b[^?]*\?/i;

const OWNER: ScriptedMember = {
  templateId: "sales-pipeline",
  agentName: "Sales",
  name: "Jordan",
  discovery: [
    "I run a small print shop in Portland, four of us. We make custom labels for other businesses.",
    "We need more customers. Almost all our work has come from word of mouth and it's slowed right down this year. Honestly I'm not sure what kind of help I even want.",
    "I don't really know who to go after, or who to talk to once I do. The few cold emails I've sent never got a reply.",
    "I bought a list of emails once and sent one big email. Two replies, both asking to be taken off.",
    "A steady few good conversations a month with businesses that actually need labels, without it eating my evenings.",
  ],
  advice: ADVICE,
  agree: AGREE,
  bar: [
    [/one thing|most want/i, "More breweries and roasters who order labels from us regularly"],
    [/great|judge|success/i, "10 new breweries or roasters a week that fit, each with the right person to email and a first email drafted"],
    [/\bstop\b|\bdeal|hate|wrong|break|(isn't|not) working/i, "Leads that are too big and print in-house, or emails that sound like spam"],
  ],
  passReason: "Too big, they print in-house",
  text: (label) =>
    /\bhow many\b|\bper (week|month)\b|\bconversations\b/i.test(label)
      ? "About 10 new leads a week to look at, and 2 good conversations a month."
      : /\bstop\b|\b(isn't|not) working\b|\bchange (approach|course)\b/i.test(label)
        ? "Leads that are too big and print in-house, or emails that sound like spam"
        : /\bwho (placed|places|ordered|orders)\b|\brole\b/i.test(label)
          ? "Usually the owner."
          : /\b(price|pricing|cost|charge|smallest order)\b/i.test(label)
            ? "About 20 cents a label; most orders are $300-1,500."
            : /\bcustomer [2-9]\b/i.test(label)
              ? undefined
              : /\b(best|ideal|top) (customers?|clients?|buyers?)|\bwho buys\b|\b(buyers?|customers?|clients?)\b/i.test(label)
                ? BUYERS
                : /\b(sell|product|offer|print)\b/i.test(label)
                  ? PRODUCT
                  : /\b(where|region|area|territory|location)\b/i.test(label)
                    ? "Oregon and Washington to start."
                    : /\b(tone|voice|sound)\b/i.test(label)
                      ? "Friendly and short, like one small business writing to another."
                      : /\b(link|url|website)\b/i.test(label)
                        ? "We don't have much of a website yet."
                        : undefined,
  // Once discovery is done, asked in plain words what they sell or who buys, they say; a list of
  // names they don't have.
  reply: (agentText) =>
    !advised && barSent(seen) && writesPlan(agentText)
      ? ((advised = true), PLAN_ADVICE)
      : barSent(seen) && /\b(do you have|send|share|paste|upload)\b[^?]*\b(contacts?|list|names)\b[^?]*\?/i.test(agentText)
        ? "I don't have a list yet; finding them is what I need help with."
        : !agreed() && ASKS_BUYERS.test(agentText) && !seen.some((x) => x.message === VAGUE)
          ? VAGUE
          : !agreed() && ASKS_BUYERS.test(agentText) && !seen.some((x) => x.message === ROUGH)
            ? ROUGH
          : agreed() && !barSent(seen) && ASKS_BUYERS.test(agentText)
          ? BUYERS
          : agreed() && !barSent(seen) && ASKS_PRODUCT.test(agentText)
            ? PRODUCT
            : undefined,
};

const FROM_BAR = /\b10\b|in-house|spam|taproom|seasonal/i;
const FROM_PASS = /in-house|too big/i;

const labelsOf = (form: UiForm) => [form.title, form.intro ?? "", ...form.fields.map((f) => f.label)].join(" | ");
const isTrial = (x: Turn) => x.form?.fields.some((f) => f.kind === "verdict" && f.items.length >= 2) ?? false;
/** The "What you sell" step's card: what they sell, who buys, their best customers, a one-pager. */
const OFFER = /\bsell|\bwho buys|\bbuyers?\b|\bbest customers?|\bideal customers?|\bone-pager|\bdeck\b|\bpric(e|ing)\b|\bwhat you (make|offer)/i;
const isOfferForm = (form: UiForm) =>
  !form.fields.some((f) => f.kind === "verdict" || f.kind === "rank") && (OFFER.test(labelsOf(form)) || form.fields.some((f) => f.kind === "file"));
/** The bar step's first card: what a great result is, how often, what would make them stop. */
const SUCCESS = /\bsuccess|\bgreat (result|week|month|lead)|\bstop using|\bhow often|\bjudge|\bdeal-?breakers?/i;

describe.skipIf(!liveFlow)("Sales pipeline setup interview against a live flow", () => {
  const session = setupSession(OWNER);
  const { turns, answer } = session;
  beforeAll(() => {
    seen = turns;
  });

  afterAll(() => session.writeLog("sales pipeline setup"));

  it("opens with a greeting and an open question, not a form", { timeout: 300_000 }, async () => {
    const first = await session.start();
    expect(first.form, describeTurn(first)).toBeNull();
    expect(first.reply, describeTurn(first)).toContain("?");
    expect(first.reply.trimStart(), describeTurn(first)).toMatch(/^Hey\b/);
  });

  it("works out where they need help, and advises where to start, before any form", { timeout: 900_000 }, async () => {
    let last = session.last();
    for (let i = 0; i < 9 && !last.form; i++) last = await answer(last);
    // (A step after discovery may run as plain questions, so a form may not have come yet.)
    const firstForm = turns.findIndex((x) => x.form);
    expect(firstForm === -1 || firstForm >= 2, turns.map(describeTurn).join("\n---\n")).toBe(true);
    const talked = turns.slice(0, firstForm === -1 ? undefined : firstForm);
    for (const x of talked) expect(x.reply, describeTurn(x)).toContain("?");
    expect(talked.filter((x) => x.events.some((e) => e.type === "questions")).length, "discovery asked through menus").toBeLessThanOrEqual(1);
    expect(talked.slice(1).some((x) => ADVICE.test(x.reply)), "no advice before the first form").toBe(true);
  });

  it("asks what they sell and who buys before the bar, then shows a trial run of real leads", { timeout: 900_000 }, async () => {
    let last = session.last();
    for (let i = 0; i < 6 && !isTrial(last) && !last.proposal; i++) last = await answer(last);
    const trial = turns.findIndex(isTrial);
    expect(trial, turns.map(describeTurn).join("\n---\n")).toBeGreaterThan(0);
    // It asks what they sell and who buys (a card, or now and then a plain question), and learns
    // who their best customers are, before the bar's first card and the trial.
    const offer = turns.findIndex((x, i) => i > 0 && ((x.form && isOfferForm(x.form)) || (!x.form && (ASKS_BUYERS.test(x.reply) || ASKS_PRODUCT.test(x.reply)))));
    const learned = turns.findIndex((x) => x.message.includes(BUYERS) || x.message === ROUGH);
    expect(learned > 0 && learned <= trial, "the trial ran before it learned who buys from them").toBe(true);
    const success = turns.findIndex((x, i) => i !== offer && x.form && !isTrial(x) && SUCCESS.test(labelsOf(x.form)));
    expect(offer, `never asked what they sell before the bar:\n${turns.slice(0, trial + 1).map(describeTurn).join("\n---\n")}`).toBeGreaterThan(0);
    expect(offer, "asked what they sell only after the trial").toBeLessThan(trial);
    expect(success === -1 || offer < success, "asked what they sell only after the bar's first card").toBe(true);
    // Real leads: companies it found with its tools, each with a link to look at, never made up.
    const items = turns[trial].form!.fields.flatMap((f) => (f.kind === "verdict" ? f.items : []));
    const linked = items.filter((item) => /^https?:\/\//.test(item.link ?? "") || /https?:\/\/|\b[\w-]+\.(com|net|org|co|beer|coffee|us)\b/i.test(item.body ?? ""));
    expect(linked.length * 2, `the trial's leads have no links: ${JSON.stringify(items)}`).toBeGreaterThanOrEqual(items.length);
    const searched = turns.slice(offer, trial + 1).some((x) => x.events.some((e) => e.type === "activity" && !["tracker", "memory"].includes(e.app ?? "") && e.action !== "write"));
    expect(searched, "the trial run used no tools").toBe(true);
    expect(items.map((item) => `${item.title} ${item.body ?? ""}`).join(" | "), "the trial isn't about breweries or roasters").toMatch(/brew|beer|coffee|roast|ale|taproom/i);
  });

  it("writes out its plan for finding customers and asks for the owner's advice before proposing", { timeout: 900_000 }, async () => {
    let last = session.last();
    for (let i = 0; i < 8 && !advised && !last.proposal; i++) last = await answer(last);
    expect(advised, turns.slice(-4).map(describeTurn).join("\n---\n")).toBe(true);
    // The plan is the reply the owner's advice answers.
    const plan = turns[turns.findIndex((x) => x.message === PLAN_ADVICE) - 1];
    expect(plan.form, describeTurn(plan)).toBeNull();
    expect(plan.proposal, describeTurn(plan)).toBeNull();
    expect(plan.reply, describeTurn(plan)).toContain("?");
  });

  it("ends with a proposal built on the owner's bar and advice, its tasks on valid schedules", { timeout: 900_000 }, async () => {
    let last = session.last();
    for (let i = 0; i < 12 && !last.proposal; i++) last = await answer(last);
    expect(last.proposal, describeTurn(last)).not.toBeNull();
    // What the app reads from it (the validated card), and what the agent sent.
    const tasks = last.proposal!.tasks;
    const raw = last.rawProposal as { tasks?: Record<string, unknown>[] };
    expect(tasks.length, JSON.stringify(raw.tasks)).toBeGreaterThan(0);
    tasks.forEach((task, i) => {
      const sent = Array.isArray(raw.tasks) ? raw.tasks[i]?.schedule : undefined;
      expect(sent == null || scheduleFrom(sent) === null || task.schedule !== null, `couldn't read "${task.title}" schedule ${JSON.stringify(sent)}`).toBe(true);
      if (task.schedule) expect(taskScheduleSchema.safeParse(task.schedule).success, `"${task.title}" schedule ${JSON.stringify(task.schedule)}`).toBe(true);
    });
    expect(tasks.some((x) => x.schedule !== null), "no proposed task runs on a schedule").toBe(true);
    const instructions = last.proposal!.instructions ?? "";
    expect(instructions, "the proposal doesn't say what success means").toMatch(/what success means/i);
    expect(FROM_BAR.test(instructions) || carriesRankedBar(turns, instructions), `the proposal dropped the owner's bar: ${instructions.slice(0, 400)}`).toBe(true);
    expect(instructions, "the bar didn't learn from what they passed on in the trial run").toMatch(FROM_PASS);
    expect(instructions, "the proposal has no plan").toMatch(/how i'll do it/i);
    expect(instructions, "the plan dropped the owner's advice").toMatch(FROM_PLAN_ADVICE);
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

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UiForm } from "@/lib/types";
import { barSent, checklistGrowth, describeTurn, liveFlow, setupSession, type ScriptedMember, type Turn } from "./setup-harness";

// A shorter eval of the Content & social setup interview against a live flow with a real model
// (LANGFLOW_TEST_* env; see setup-harness.ts): from discovery to the trial run, for a freelancer
// who keeps putting off posting. The trial drafts posts, so it's only fair once the agent has
// read their writing: the "Your voice" step has to come first. The bookkeeper and their posts
// are made up.

const ADVICE = /\b(recommend|suggest|i'd start|start with|help (you )?most|where i (can|could) help|here's my read|i think i (can|could)|i'd leave)\b/i;

/** Posts they're proud of, as they'd paste them when asked: both in one box, or one per box. */
const POST_1 = `Your restaurant isn't losing money on the slow nights. It's losing it on the busy ones.

Last month a client's Saturday food cost hit 38%. Tuesday? 29%. Rushed prep, heavy portions, comped desserts.

One change fixed it: a portion card on the line.

Check your best night first.`;
const POST_2 = `Three numbers I check for every restaurant client, every Monday:
1. Prime cost (food + labor) under 60%
2. Cash on hand for 6 weeks of payroll
3. Any vendor price that moved more than 5%

That's it. Twenty minutes, coffee in hand.`;
const SAMPLES = `${POST_1}\n\n---\n\n${POST_2}`;
/** Something real from this week, for a post built on their work. Made up. */
const STORY = "This week a café client found they'd been paying for the same produce delivery twice for three months. $2,400 back, caught by matching invoices to delivery slips.";

let seen: Turn[] = [];
const AGREE = "Yes, drafting posts from what happens with my clients is where I need you most. Planning can come later.";
const agreed = () => seen.some((x) => x.message === AGREE);

const FREELANCER: ScriptedMember = {
  templateId: "content-social",
  agentName: "Content",
  name: "Avery",
  discovery: [
    "I'm a freelance bookkeeper. Most of my clients are independent restaurants.",
    "I know I should be posting on LinkedIn to find new clients, but I keep putting it off. When I do post it's once in a blue moon.",
    "The blank page. I have plenty of stories from clients' books, but I can't turn them into posts quickly, and half the time I don't know what to post about.",
    "I tried one of those AI post generators. Everything sounded like a motivational poster, nothing like me.",
    "I'd post twice a week without dreading it, and a restaurant owner or two would get in touch each month because of it.",
  ],
  advice: ADVICE,
  agree: AGREE,
  bar: [
    [/one thing|most want/i, "Post on LinkedIn twice a week in my own voice"],
    [/great|judge|success/i, "Two LinkedIn drafts a week, each built on a real story from my work, under 150 words, that I'd post with light edits"],
    [/\bstop\b|\bdeal|hate|wrong|break|never/i, "Hashtags, emojis, or anything that sounds like a motivational poster"],
  ],
  passReason: "Generic advice, not from my clients",
  text: (label) =>
    /\b(sample|piece|post|example) (1|one)\b|\bfirst\b/i.test(label)
      ? POST_1
      : /\b(sample|piece|post|example) (2|two)\b|\bsecond\b/i.test(label)
        ? POST_2
        : /\b(sample|piece|post|example) [3-5]\b|\b(third|fourth|fifth)\b/i.test(label)
          ? undefined
          : /\b(pieces?|posts?|samples?|examples?|paste|proud|written|links?)\b/i.test(label)
      ? SAMPLES
      : /\b(story|stories|recent|this week|lately|happened)\b/i.test(label)
        ? STORY
        : /\b(audience|reach|talking to|readers?)\b/i.test(label)
          ? "Owners of independent restaurants with one to three locations."
          : /\b(topics?|known for|themes?)\b/i.test(label)
            ? "Restaurant money: food cost, cash flow, and getting ready for tax time."
            : /\b(channels?|platforms?|where)\b/i.test(label)
              ? "LinkedIn mostly; Instagram now and then."
              : undefined,
  // Once discovery is done, asked in plain words for their writing or a recent story, they give it.
  reply: (agentText) =>
    agreed() && !barSent(seen) && /\b(paste|share|send)\b[^?]*\b(posts?|pieces?|writing|examples?|samples?)\b[^?]*\?/i.test(agentText)
      ? SAMPLES
      : agreed() && !barSent(seen) && /\b(story|stories|moment|happened|this week|lately|tell me about)\b/i.test(agentText)
        ? STORY
        : undefined,
};

const labelsOf = (form: UiForm) => [form.title, form.intro ?? "", ...form.fields.map((f) => f.label)].join(" | ");
const isTrial = (x: Turn) => x.form?.fields.some((f) => f.kind === "verdict" && f.items.length >= 2) ?? false;
/** The "Your voice" step's card: pieces they're proud of, what they never want to sound like. */
const VOICE = /\bvoice\b|\bproud\b|\bpieces?\b|\bsamples?\b|\bexamples?\b|\bpaste\b|\bsound like\b|\byour (posts|writing)\b/i;
const isVoiceForm = (form: UiForm) => !form.fields.some((f) => f.kind === "verdict" || f.kind === "rank") && VOICE.test(labelsOf(form));
const SUCCESS = /\bsuccess|\bgreat (result|week|month|post)|\bstop using|\bhow often|\bjudge|\bdeal-?breakers?/i;

describe.skipIf(!liveFlow)("Content & social setup interview against a live flow, to the trial run", () => {
  const session = setupSession(FREELANCER);
  const { turns, answer } = session;
  beforeAll(() => {
    seen = turns;
  });

  afterAll(() => session.writeLog("content & social setup"));

  it("works out where they need help, and advises where to start, before any form", { timeout: 900_000 }, async () => {
    let last = await session.start();
    expect(last.form, describeTurn(last)).toBeNull();
    expect(last.reply.trimStart(), describeTurn(last)).toMatch(/^Hey\b/);
    for (let i = 0; i < 9 && !last.form; i++) last = await answer(last);
    // (A step after discovery may run as plain questions, so a form may not have come yet.)
    const firstForm = turns.findIndex((x) => x.form);
    expect(firstForm === -1 || firstForm >= 2, turns.map(describeTurn).join("\n---\n")).toBe(true);
    const talked = turns.slice(0, firstForm === -1 ? undefined : firstForm);
    for (const x of talked) expect(x.reply, describeTurn(x)).toContain("?");
    expect(talked.slice(1).some((x) => ADVICE.test(x.reply)), "no advice before the first form").toBe(true);
  });

  it("reads their writing before the bar, then drafts a trial run in their voice", { timeout: 900_000 }, async () => {
    let last = session.last();
    for (let i = 0; i < 6 && !isTrial(last) && !last.proposal; i++) last = await answer(last);
    const trial = turns.findIndex(isTrial);
    expect(trial, turns.map(describeTurn).join("\n---\n")).toBeGreaterThan(0);
    // Asked for their writing on a card, or now and then in plain words, before drafting anything.
    const voice = turns.findIndex((x, i) => (x.form && isVoiceForm(x.form)) || (!x.form && turns[i + 1]?.message.includes(POST_1)));
    const success = turns.findIndex((x, i) => i !== voice && x.form && !isTrial(x) && SUCCESS.test(labelsOf(x.form)));
    expect(voice, `never asked for their writing before the bar:\n${turns.slice(0, trial + 1).map(describeTurn).join("\n---\n")}`).toBeGreaterThan(0);
    expect(voice, "asked for their writing only after the trial").toBeLessThan(trial);
    expect(success === -1 || voice < success, "asked for their writing only after the bar's first card").toBe(true);
    // Drafts on their own field, built on something real from their work, not generic advice.
    const drafts = turns[trial].form!.fields.flatMap((f) => (f.kind === "verdict" ? f.items.map((item) => `${item.title} ${item.body ?? ""}`) : []));
    expect(drafts.join(" | "), "the trial's drafts aren't about their work").toMatch(/restaurant|food cost|café|cafe|menu|kitchen|payroll|invoice|vendor|bookkeep/i);
  });

  it("lists only what it knows: three steps to start, and nothing past the bar before it's confirmed", () => {
    const growth = checklistGrowth(turns);
    expect(growth.first, "no checklist on the first reply").not.toBeNull();
    expect(growth.first!, "the first checklist laid out the whole setup").toBeLessThanOrEqual(3);
    expect(growth.early, "the checklist listed later setup before the bar was confirmed").toEqual([]);
  });

  it("changes nothing outside the member's own notes", () => {
    const events = turns.flatMap((x) => x.events);
    expect(events.filter((e) => e.type === "approval")).toEqual([]);
    const wrote = events.filter(
      (e) => e.type === "activity" && e.action === "write" && e.status === "done" && !["tracker", "memory"].includes(e.app ?? ""),
    );
    expect(wrote).toEqual([]);
  });
});

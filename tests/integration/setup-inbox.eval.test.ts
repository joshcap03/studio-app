import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { barSent, checklistGrowth, describeTurn, liveFlow, setupSession, type ScriptedMember, type Turn } from "./setup-harness";

// A shorter eval of the Inbox & calendar setup interview against a live flow with a real model
// (LANGFLOW_TEST_* env; see setup-harness.ts): from discovery to the trial run, for someone whose
// inbox isn't connected and who'd rather paste a few emails than connect it yet. The trial is
// about their own inbox, so it has to say what it can't see and work from what they paste. The
// account manager, their clients, and the emails are made up.

const ADVICE = /\b(recommend|suggest|i'd start|start with|help (you )?most|where i (can|could) help|here's my read|i think i (can|could)|i'd leave)\b/i;

/** This morning's inbox, as they'd paste it when asked. */
const EMAILS = `From: Dana at Pinecrest Outfitters (client): Can we push Thursday's brand review to Friday? Our CEO is out Thursday.
From: Team chat digest: 14 new messages in #general
From: Lee at Harbor Lane Coffee (client): The invoice looks off. We were quoted $4,200, not $4,800.
From: Design tool: Your weekly activity summary
From: Sam (internal): Lunch Friday?`;
const NO_CONNECT = "I'd rather not connect my email yet. Here are this morning's emails instead:\n" + EMAILS;

let seen: Turn[] = [];
const AGREE = "Yes, start with catching what needs me from clients each morning. Drafting replies would be a bonus.";
const agreed = () => seen.some((x) => x.message === AGREE);

const MANAGER: ScriptedMember = {
  templateId: "inbox-calendar",
  agentName: "Inbox",
  name: "Riley",
  discovery: [
    "I'm an account manager at a small design agency. I look after about a dozen clients.",
    "My inbox is out of control. A couple hundred emails a day, and client emails get buried under internal threads and notifications.",
    "Last week I missed a client asking to move a deadline and found it two days later. That's what scares me.",
    "I've tried filters and stars. The filters miss things, and I stop starring when it gets busy.",
    "Every morning I'd know which client emails need me today, and nothing from a client would sit unanswered for more than a day.",
  ],
  advice: ADVICE,
  agree: AGREE,
  bar: [
    [/one thing|most want/i, "Never miss a client email that needs me"],
    [/great|judge|success/i, "By 9am each weekday, every client email that needs me today, with one line on what they want"],
    [/\bstop\b|\bdeal|hate|wrong|break|never/i, "Missing a client email, or newsletters on the list"],
  ],
  passReason: "Internal, not a client",
  text: (label) =>
    /\bhow many\b|\bat most\b/i.test(label)
      ? "10 at most."
      : /\bhow (fast|soon|quickly)\b/i.test(label)
        ? "Within the hour during the workday."
        : /\b(paste|emails?|inbox|messages?)\b/i.test(label)
      ? EMAILS
      : /\b(clients?|people|senders?|who matters)\b/i.test(label)
        ? "Pinecrest Outfitters and Harbor Lane Coffee are my biggest clients; anyone from a client domain matters."
        : /\b(hours?|when)\b/i.test(label)
          ? "9 to 6 on weekdays."
          : undefined,
  // Once discovery is done, asked to connect their email or share some, they paste this morning's.
  reply: (agentText) =>
    agreed() && !barSent(seen) && /\b(connect|paste|share|forward|send)\b[^?]*\b(gmail|outlook|email|inbox|emails|messages)\b[^?]*\?/i.test(agentText) ? NO_CONNECT : undefined,
};

const isTrial = (x: Turn) => x.form?.fields.some((f) => f.kind === "verdict" && f.items.length >= 2) ?? false;
/** Saying what it can't reach yet: their inbox isn't connected. */
const MISSING_APP =
  /\b(?:(?:isn't|is not|aren't|are not|not)(?: yet)? connected|(?:once|until) [^.]{0,40}\bconnect|connect (?:it|your|gmail|outlook)|(?:can't|cannot|couldn't) (?:see|reach|read|access)|no access|don't have access|without access)/i;
const plain = (s: string) => s.replace(/[‘’]/g, "'");

describe.skipIf(!liveFlow)("Inbox & calendar setup interview against a live flow, to the trial run", () => {
  const session = setupSession(MANAGER);
  const { turns, answer } = session;
  beforeAll(() => {
    seen = turns;
  });

  afterAll(() => session.writeLog("inbox & calendar setup"));

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

  it("offers to connect their inbox or says what it can't see, then runs the trial on what they paste", { timeout: 900_000 }, async () => {
    let last = session.last();
    for (let i = 0; i < 6 && !isTrial(last) && !last.proposal; i++) last = await answer(last);
    const trial = turns.findIndex(isTrial);
    expect(trial, turns.map(describeTurn).join("\n---\n")).toBeGreaterThan(0);
    const before = turns.slice(1, trial + 1);
    const offered = before.some((x) => x.form?.fields.some((f) => f.kind === "connect"));
    const said = before.some((x) => [x.reply, x.form?.intro ?? ""].some((text) => MISSING_APP.test(plain(text)) || /\bpaste\b/i.test(text)));
    expect(offered || said, before.map(describeTurn).join("\n---\n")).toBe(true);
    // Its results are their own emails, never made-up ones.
    const items = turns[trial].form!.fields.flatMap((f) => (f.kind === "verdict" ? f.items.map((item) => `${item.title} ${item.body ?? ""}`) : []));
    expect(items.join(" | "), "the trial isn't about the emails they pasted").toMatch(/pinecrest|harbor lane|dana|\blee\b|brand review|invoice/i);
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

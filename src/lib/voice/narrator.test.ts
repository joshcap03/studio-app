import { describe, expect, it } from "vitest";
import type { ActivityStep, ChatMessage, StreamEvent } from "@/lib/types";
import { CallNarrator, LONG_JOB_MS } from "./narrator";
import { sentences } from "./relay";

// Replays of what a call is sent during a run, the way the Langflow adapter and turn.ts send it,
// checking what the voice is handed to say.

const OPENING =
  "Here's what we'll do together: I'll understand what's hard about your search right now, and then set up how I work. To start: what's been the hardest part of your job search lately?";
const ANSWER = "Got it: you want to reach strong product-hiring companies and meet people there. Which is harder right now, finding the roles or reaching the people?";

const message = (patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1",
  conversationId: "c1",
  role: "assistant",
  content: "",
  status: "complete",
  activity: [],
  artifacts: [],
  createdAt: 0,
  ...patch,
});
const step = (patch: Partial<ActivityStep>): ActivityStep => ({ id: "s1", label: "Searching the web", status: "running", app: "web", startedAt: 0, ...patch });
const activity = (patch: Partial<ActivityStep>): StreamEvent => ({ type: "activity", step: step(patch) });
const start: StreamEvent = { type: "start", conversation: {} as never, userMessage: {} as never, assistantMessage: message({ status: "streaming" }) };
const text = (delta: string): StreamEvent => ({ type: "text", delta });

/** An opening line, a plan update, then the opening line released into the reply (the held-note path). */
const held = (opening: string): StreamEvent[] => [
  start,
  activity({ id: "note:0", action: "note", status: "done", app: "agent", label: opening }),
  activity({ id: "plan", label: "Updating the plan", app: "tracker", action: "write" }),
  activity({ id: "plan", label: "Updated the plan", status: "done", app: "tracker", action: "write" }),
  activity({ id: "note:0", action: "note", status: "done", app: "agent", label: opening, hidden: true }),
  text(`${opening}\n\n`),
  text(ANSWER),
];
const heldReply = (opening: string) => message({ content: `${opening}\n\n${ANSWER}` });
/** Short enough to be said as an opening line while it works. */
const SHORT_OPENING = "Let me start a checklist for us. What's been the hardest part of your search lately?";

function call() {
  const narrator = new CallNarrator();
  const spoken: string[] = [];
  let now = 100_000;
  return {
    narrator,
    spoken,
    feed(events: StreamEvent[]) {
      for (const e of events) narrator.event(e);
    },
    /** The floor comes free. */
    flush(running = false) {
      now += 10_000;
      spoken.push(...narrator.take(now, { running, quietMs: 1000 }));
    },
  };
}

/** Every sentence the voice was handed, with how many times. */
function counts(spoken: string[]) {
  const all = spoken.flatMap((line) => sentences(line)).map((s) => s.toLowerCase());
  return all.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {});
}
const saidOnce = (spoken: string[]) => Object.values(counts(spoken)).every((n) => n === 1);

describe("CallNarrator", () => {
  it("says an opening line once when it comes back as part of the reply", () => {
    const c = call();
    c.feed(held(SHORT_OPENING).slice(0, 2));
    c.flush(true);
    expect(c.spoken).toEqual([SHORT_OPENING]);
    c.feed(held(SHORT_OPENING).slice(2));
    c.narrator.reply(heldReply(SHORT_OPENING));
    c.flush();
    expect(c.spoken.join(" ")).toContain("Which is harder right now");
    expect(saidOnce(c.spoken)).toBe(true);
  });

  it("says it once even when the floor was busy until the run ended", () => {
    for (const opening of [SHORT_OPENING, OPENING]) {
      const c = call();
      c.feed(held(opening));
      c.narrator.reply(heldReply(opening));
      c.flush();
      expect(saidOnce(c.spoken)).toBe(true);
      // One question: the one the reply ends on.
      expect(c.spoken.join(" ")).toContain("Which is harder right now");
      expect(c.spoken.join(" ")).not.toContain("hardest part");
    }
  });

  it("says nothing twice when the reply was read as soon as it was written and the opening line comes back in it", () => {
    const c = call();
    c.feed(held(SHORT_OPENING).slice(0, 2));
    c.flush(true);
    c.feed([...held(SHORT_OPENING).slice(2), activity({ id: "mem", label: "Remembering this", action: "remember", app: "memory" })]);
    c.flush(true);
    c.narrator.reply(heldReply(SHORT_OPENING));
    c.flush();
    expect(saidOnce(c.spoken)).toBe(true);
    expect(c.spoken.join(" ")).toContain("Which is harder right now");
  });

  it("says a reply read as soon as it was written once, when the agent keeps its books and when it ends", () => {
    const c = call();
    c.feed([start, text(ANSWER), activity({ id: "mem", label: "Remembering this", action: "remember", app: "memory" })]);
    c.flush(true);
    expect(c.spoken.join(" ")).toContain("Which is harder right now");
    c.feed([activity({ id: "mem", label: "Remembered", action: "remember", app: "memory", status: "done" })]);
    c.narrator.reply(message({ content: ANSWER }));
    c.flush();
    expect(saidOnce(c.spoken)).toBe(true);
  });

  it("says a closing question with its hint once, read as soon as it was written", () => {
    const asks = "Got it, the company matters more than the title. What does a right company look like to you? Think about the work, the stage, the people.";
    const c = call();
    c.feed([start, text(asks), activity({ id: "plan", label: "Updating the plan", app: "tracker", action: "write" })]);
    c.flush(true);
    c.narrator.reply(message({ content: asks }));
    c.flush();
    expect(c.spoken).toEqual([asks]);
  });

  it("adds nothing when the hint was left on screen to make room for the reply's lead", () => {
    const lead = "Got it: I won't contact anyone for you, and I'll leave the outreach part to you. I'll note that as a standing rule.";
    const asks = `${lead}\n\nNow, back to the fit question: what would a role need to clear for you to call it a fit? Give me the pay floor, remote or location, the stack you want to keep using, and whether a smaller team is a must or just a preference.`;
    const c = call();
    c.feed([start, text(asks), activity({ id: "plan", label: "Updating the plan", app: "tracker", action: "write" })]);
    c.flush(true);
    c.narrator.reply(message({ content: asks }));
    c.flush();
    expect(c.spoken).toHaveLength(1);
    expect(c.spoken[0]).toMatch(/call it a fit\?$/);
  });

  it("says a run's lines once even when the next run starts before they're said", () => {
    // Held words go along as soon as a run ends, so its reply can still be waiting for the floor.
    const c = call();
    c.feed(held(SHORT_OPENING).slice(0, 2));
    c.flush(true);
    c.feed(held(SHORT_OPENING).slice(2));
    c.narrator.reply(heldReply(SHORT_OPENING), { superseded: true });
    c.feed([start]);
    c.flush(true);
    expect(saidOnce(c.spoken)).toBe(true);
    expect(c.spoken.join(" ")).toContain("meet people there");
  });

  it("reads a reply caught up on joining once, even when its run's end arrives too", () => {
    const c = call();
    const done = message({ content: ANSWER });
    c.narrator.reply(done);
    c.narrator.reply(done);
    c.flush();
    expect(saidOnce(c.spoken)).toBe(true);
    expect(c.spoken).toHaveLength(1);
  });

  it("leaves a reply's question unsaid when what the member said meanwhile goes along next", () => {
    const c = call();
    c.feed([start, text(ANSWER)]);
    c.narrator.reply(message({ content: ANSWER }), { superseded: true });
    c.flush();
    expect(c.spoken.join(" ")).toContain("meet people there");
    expect(c.spoken.join(" ")).not.toContain("Which is harder");
  });

  it("says a progress step once, and a new turn's words again", () => {
    const c = call();
    c.feed([start, activity({ id: "a", label: "Searching the web" }), activity({ id: "b", label: "Searching the web" })]);
    c.flush(true);
    c.flush(true);
    expect(c.spoken).toEqual(["I'm searching the web."]);
    c.feed([start, activity({ id: "a", label: "Searching the web" })]);
    c.flush(true);
    expect(c.spoken).toEqual(["I'm searching the web.", "I'm searching the web."]);
  });

  it("gives a quiet run one holding line a turn", () => {
    const narrator = new CallNarrator();
    narrator.event(start);
    expect(narrator.take(1, { running: true, quietMs: 9500 })).toEqual(["Still working on it."]);
    expect(narrator.take(2, { running: true, quietMs: 20_000 })).toEqual([]);
  });

  it("cues the heads-up and time's up once each, however often the clock ticks", () => {
    const narrator = new CallNarrator();
    const cues = Array.from({ length: 300 }, (_, s) => narrator.clock(s, 240)).filter(Boolean);
    expect(cues).toEqual(["heads_up", "time_up"]);
    const short = new CallNarrator();
    expect(Array.from({ length: 100 }, (_, s) => short.clock(s, 90)).filter(Boolean)).toEqual(["time_up"]);
  });
});

describe("a long job", () => {
  it("is asked about once a turn, after a long stretch with nothing new", () => {
    const narrator = new CallNarrator();
    narrator.event(start, 0);
    expect(narrator.longJob(LONG_JOB_MS - 1, true)).toBe(false);
    // Something new puts it off.
    narrator.event(activity({ id: "s2", label: "Reading the results" }), 30_000);
    expect(narrator.longJob(LONG_JOB_MS + 1, true)).toBe(false);
    expect(narrator.longJob(30_000 + LONG_JOB_MS, true)).toBe(true);
    expect(narrator.longJob(30_000 + 3 * LONG_JOB_MS, true)).toBe(false);
    // A hidden step isn't news; a new turn can be asked about again.
    narrator.event(start, 200_000);
    narrator.event(activity({ id: "h", label: "Looking up tools", hidden: true }), 230_000);
    expect(narrator.longJob(200_000 + LONG_JOB_MS, true)).toBe(true);
  });

  it("counts a run already going when the call joined from when it was first seen, and not at all once it's done", () => {
    const narrator = new CallNarrator();
    expect(narrator.longJob(5_000, true)).toBe(false);
    expect(narrator.longJob(5_000 + LONG_JOB_MS, true)).toBe(true);
    const idle = new CallNarrator();
    expect(idle.longJob(0, false)).toBe(false);
    expect(idle.longJob(10 * LONG_JOB_MS, false)).toBe(false);
  });

  it("says that it came back ahead of the reply, when it did just as the call was hanging up for its note", () => {
    const { narrator, spoken, feed, flush } = call();
    feed([start]);
    narrator.aside("Actually, it just came back.");
    narrator.reply(message({ content: "Found three roles. The best is remote." }));
    flush();
    expect(spoken).toEqual(["Actually, it just came back.", "Found three roles. The best is remote."]);
  });
});

describe("a request's read-back", () => {
  const readBack = "I'll email jo@acme.example, subject “March invoice”, saying “Hi Jo”.";
  const awaiting = message({
    status: "awaiting",
    content: "Here's the email.",
    approvals: [{ id: "a1", summary: "Email Jo", details: [], status: "pending", createdAt: 0, spoken: { ok: true, readBack } }],
  });

  it("is said whole, never cut at the dots in an address", () => {
    const narrator = new CallNarrator();
    narrator.reply(awaiting, { spokenApprovals: true });
    expect(narrator.take(0, { running: false, quietMs: 0 })).toEqual(["Here's the email.", `${readBack} Say “send it” to go ahead, or tap.`]);
  });

  it("can be said again, word for word, when it must be heard again", () => {
    const narrator = new CallNarrator();
    narrator.reply(awaiting, { spokenApprovals: true });
    narrator.take(0, { running: false, quietMs: 0 });
    // The same reply isn't read twice...
    narrator.reply(awaiting, { spokenApprovals: true });
    expect(narrator.take(1, { running: false, quietMs: 0 })).toEqual([]);
    // ...but the read-back is, when asked.
    narrator.again(`${readBack} Say “send it” to go ahead, or tap.`);
    expect(narrator.take(2, { running: false, quietMs: 0 })).toEqual([`${readBack} Say “send it” to go ahead, or tap.`]);
  });

  it("is a tap line where spoken approvals are off", () => {
    const narrator = new CallNarrator();
    narrator.reply(awaiting);
    expect(narrator.take(0, { running: false, quietMs: 0 }).at(-1)).toBe("It needs your OK on screen: Email Jo. Approvals are taps for now.");
  });
});

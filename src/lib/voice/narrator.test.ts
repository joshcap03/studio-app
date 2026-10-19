import { describe, expect, it } from "vitest";
import type { ActivityStep, ChatMessage, StreamEvent } from "@/lib/types";
import { CallNarrator } from "./narrator";
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

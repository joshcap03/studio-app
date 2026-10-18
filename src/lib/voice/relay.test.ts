import { describe, expect, it } from "vitest";
import type { ActivityStep, ChatMessage, StreamEvent } from "@/lib/types";
import { cardLine, initialRelay, plain, relayEvent, relayJourney, relayReply, speakableGist, type RelayState } from "./relay";

const step = (patch: Partial<ActivityStep>): ActivityStep => ({ id: "s1", label: "Searching the web", status: "running", app: "web", startedAt: 0, ...patch });
const activity = (s: ActivityStep): StreamEvent => ({ type: "activity", step: s });

function run(events: StreamEvent[]) {
  let state: RelayState = initialRelay();
  const lines: string[] = [];
  for (const e of events) {
    const out = relayEvent(state, e);
    state = out.state;
    lines.push(...out.lines.map((l) => l.text));
  }
  return lines;
}

const reply = (patch: Partial<ChatMessage>): ChatMessage => ({
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

describe("relayEvent", () => {
  it("says each step once, when it starts, in the step's own words", () => {
    const lines = run([activity(step({})), activity(step({ status: "done", label: "Searched the web" })), activity(step({ id: "s2", label: "Reading your résumé", app: "agent" }))]);
    expect(lines).toEqual(["Searching the web…", "Reading your résumé…"]);
  });

  it("says the agent's own opening lines, but never hidden steps or talk of its machinery", () => {
    const lines = run([
      activity(step({ id: "n1", action: "note", status: "done", label: "Let me read your résumé first." })),
      activity(step({ id: "h1", hidden: true, label: "Looking up tools" })),
      activity(step({ id: "n2", action: "note", status: "done", label: "I'll call the composio tool now" })),
      activity(step({ id: "x1", label: "Read {\"rows\": 3}" })),
    ]);
    expect(lines).toEqual(["Let me read your résumé first."]);
  });

  it("starts over on a new turn", () => {
    expect(run([activity(step({})), { type: "start" } as StreamEvent, activity(step({}))])).toEqual(["Searching the web…", "Searching the web…"]);
  });
});

describe("relayJourney", () => {
  it("says what a step that just finished gave the agent", () => {
    const before = [{ text: "Your résumé", status: "doing" as const }, { text: "Your search", status: "todo" as const }];
    const after = [{ text: "Your résumé", status: "done" as const, note: "Read it: 8 years in B2B SaaS" }, { text: "Your search", status: "doing" as const }];
    expect(relayJourney(before, after).map((l) => l.text)).toEqual(["Read it: 8 years in B2B SaaS."]);
    expect(relayJourney(after, after)).toEqual([]);
  });
});

describe("relayReply", () => {
  it("says the gist and points at the screen for the rest", () => {
    const text = relayReply(reply({ content: "Hey! Three roles cleared your bar. The best is remote at $195k. Here are all the details:\n\n| Role | Pay |\n|---|---|\n| A | 1 |" }))[0].text;
    expect(text).toBe("Three roles cleared your bar. The best is remote at $195k. The rest is on screen.");
  });

  it("reads a card's own words and says how to answer", () => {
    const lines = relayReply(
      reply({
        content: "Next, your search.",
        ui: [{ kind: "form", id: "f", title: "Your search", intro: "A few things.", submitLabel: "Next", fields: [{ kind: "file", id: "r", label: "Résumé", required: false, accept: ["pdf"], max: 1, keep: true }] }],
      }),
    );
    expect(lines.map((l) => l.kind)).toEqual(["reply", "card"]);
    expect(lines[1].text).toBe("Your search. A few things. Tell me your answers (files and apps are taps), and say “send” when it's right.");
  });

  it("reads questions with their options", () => {
    const lines = relayReply(reply({ content: "", questions: [{ question: "Who should get it", options: [{ label: "Everyone" }, { label: "Repeat buyers" }], multiSelect: false }] }));
    expect(lines.map((l) => l.text)).toEqual(["Who should get it. Everyone, or Repeat buyers."]);
  });

  it("names an approval as a tap and reports failures with a retry", () => {
    const awaiting = reply({ status: "awaiting", approvals: [{ id: "a", summary: "Send a reply to Casting Co", details: [], status: "pending", createdAt: 0 }] });
    expect(relayReply(awaiting).at(-1)?.text).toBe("It needs your OK on screen: Send a reply to Casting Co. That one's a tap.");
    expect(relayReply(reply({ status: "error", error: "Shopify timed out" }))[0].text).toContain("Say “try again”");
    expect(relayReply(reply({ status: "interrupted" }))[0].text).toContain("cut off");
  });

  it("doesn't read a card that was already answered", () => {
    const block = { kind: "proposal" as const, id: "p", summary: "I'll look every weekday.", skills: [], tasks: [], memories: [] };
    expect(relayReply(reply({ ui: [block], uiResponse: { p: { status: "submitted", at: 0 } } }))).toEqual([]);
    expect(cardLine(block)).toBe("I'll look every weekday. It's on screen. Tap Apply when it looks right.");
  });
});

describe("plain", () => {
  it("turns markdown into words for the ear", () => {
    expect(plain("**Three** roles [on LinkedIn](https://linkedin.com/x) cleared it [1]. See `code` and https://x.example/y")).toBe("Three roles on LinkedIn cleared it. See code and");
    expect(plain("- one\n- two")).toBe("one two");
  });

  it("keeps a short reply whole", () => {
    expect(speakableGist("Got it.")).toBe("Got it.");
    expect(speakableGist("")).toBe("");
  });
});

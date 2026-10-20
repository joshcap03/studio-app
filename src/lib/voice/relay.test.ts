import { describe, expect, it } from "vitest";
import type { ActivityStep, ChatMessage, StreamEvent } from "@/lib/types";
import { cardLine, closingQuestion, initialRelay, plain, relayEvent, relayJourney, relayReply, speakableGist, waitsOnMember, type RelayState } from "./relay";

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
  it("says a step the way someone would, in its own words", () => {
    expect(run([activity(step({ label: "Checking Gmail for replies" }))])).toEqual(["I'm checking Gmail for replies."]);
    expect(run([activity(step({ label: "Gmail search" }))])).toEqual(["Gmail search…"]);
  });

  it("says each step once, when it starts, in the step's own words", () => {
    const lines = run([activity(step({})), activity(step({ status: "done", label: "Searched the web" })), activity(step({ id: "s2", label: "Reading your résumé", app: "agent" }))]);
    expect(lines).toEqual(["I'm searching the web.", "I'm reading your résumé."]);
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

  it("leaves the agent's bookkeeping (its plan, its memory) unsaid", () => {
    const lines = run([
      activity(step({ id: "p", label: "Updating the plan", app: "tracker", action: "write" })),
      activity(step({ id: "m", label: "Updating memory", app: "memory", action: "remember" })),
      activity(step({ id: "w", label: "Searching the web" })),
    ]);
    expect(lines).toEqual(["I'm searching the web."]);
  });

  it("starts over on a new turn", () => {
    expect(run([activity(step({})), { type: "start" } as StreamEvent, activity(step({}))])).toEqual(["I'm searching the web.", "I'm searching the web."]);
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

  it("always ends on the reply's own question, so the call asks what the chat asks", () => {
    const text = relayReply(
      reply({
        content: "Thanks, that helps. Networking is where most searches stall. I've seen it a lot.\n\nWhich part is hardest: finding people, reaching out, or following up?",
      }),
    )[0].text;
    expect(text).toBe("Thanks, that helps. Networking is where most searches stall. The rest is on screen. Which part is hardest: finding people, reaching out, or following up?");
    expect(speakableGist("Got it. What's been hardest lately?")).toBe("Got it. What's been hardest lately?");
  });

  it("asks one question: the one the reply ends on", () => {
    expect(speakableGist("Let me start a checklist. What's been hardest lately?\n\nGot it: you want to meet people. Which is harder, the roles or the people?")).toBe(
      "Let me start a checklist. Got it: you want to meet people. The rest is on screen. Which is harder, the roles or the people?",
    );
    expect(speakableGist("Is it remote? I'll check. Here's what I found.")).toBe("Is it remote? I'll check. The rest is on screen.");
  });

  it("says the question the last paragraph ends on, with a short hint after it, so the line is never silent", () => {
    expect(speakableGist("What does a right company look like to you? Think about the work, the stage, the people.")).toBe(
      "What does a right company look like to you? Think about the work, the stage, the people.",
    );
    const noise =
      "So the problem is noise, not a shortage of roles. Most postings are wrong in some way.\n\nIf you could only see roles you'd consider, what would they need? Think about the non-negotiables, like pay, remote, or stack.";
    expect(speakableGist(noise)).toBe(
      "So the problem is noise, not a shortage of roles. Most postings are wrong in some way. If you could only see roles you'd consider, what would they need? Think about the non-negotiables, like pay, remote, or stack.",
    );
    // A hint too long to say goes on screen; the question is still said last.
    const long = `Got it. That's a clear target. What would a role need to clear? ${"Pay, remote, stack, team size, and the rest of what you'd weigh, ".repeat(3)}all of it.`;
    expect(speakableGist(long)).toBe("Got it. That's a clear target. The rest is on screen. What would a role need to clear?");
  });

  it("says its lead before a hint when there's room for only one, and never cuts the lead short", () => {
    const lead = "Got it: I won't contact anyone for you, and I'll leave the outreach part to you. I'll note that as a standing rule.";
    const question = "Now, back to the fit question: what would a role need to clear for you to call it a fit?";
    const hint = "Give me the pay floor, remote or location, the stack you want to keep using, and whether a smaller team is a must or just a preference.";
    expect(speakableGist(`${lead}\n\n${question} ${hint}`)).toBe(`${lead} The rest is on screen. ${question}`);
  });

  it("says a reply written twice once, and a greeting in the middle not at all", () => {
    const twice = "Got it, so the title matters less than the company. Would a senior role be a step back?";
    expect(speakableGist(`${twice}${twice}`)).toBe(twice);
    expect(speakableGist("I'll learn what's hard first.\n\nWhat's hardest?Hey! Let's do this in steps.\n\nWhat's hardest?")).toBe(
      "I'll learn what's hard first. Let's do this in steps. What's hardest?",
    );
  });

  it("keeps a question that leans on the one before it whole", () => {
    expect(closingQuestion("The problem is the filter. Did the searches keep sending the wrong roles? Or did the volume alone wear you down?")).toBe(
      "Did the searches keep sending the wrong roles? Or did the volume alone wear you down?",
    );
  });

  it("asks nothing when the last paragraph moves on after its question", () => {
    expect(closingQuestion("What's hardest?\n\nHere's what I found. Three roles fit. I'll keep looking.")).toBeNull();
    expect(closingQuestion("Is it remote? I'll check. Here's what I found.")).toBeNull();
  });

  it("stays within its length, question and all", () => {
    const detail = Array.from({ length: 6 }, (_, i) => `Point ${i + 1} is about the roles you've seen and why they missed, in some detail.`).join(" ");
    const question = `Which of these is a hard no for you, ${"the stack, the level, the pay, ".repeat(4)}or company size?`;
    const gist = speakableGist(`${detail}\n\n${question}`);
    expect(gist.length).toBeLessThanOrEqual(320);
    expect(gist.endsWith(question)).toBe(true);
    expect(gist).toContain("The rest is on screen.");
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

describe("calls from anywhere", () => {
  it("never says an offer to call on one", () => {
    const offer = { kind: "offer" as const, id: "o", reason: "Quicker to talk it through." };
    expect(relayReply(reply({ content: "Two ways to go.", ui: [offer] })).map((l) => l.text)).toEqual(["Two ways to go."]);
    expect(cardLine(offer)).toBe("");
  });

  it("reads a reply a call joins only when it waits on the member", () => {
    const pending = { id: "a", summary: "Send it", details: [] as [string, string][], status: "pending" as const, createdAt: 0 };
    expect(waitsOnMember(reply({ content: "Found two roles. Which first, Acme or Globex?" }))).toBe(true);
    expect(waitsOnMember(reply({ content: "Here.", ui: [{ kind: "form", id: "f", title: "Your search", fields: [], submitLabel: "Send" }] }))).toBe(true);
    expect(waitsOnMember(reply({ status: "awaiting", content: "Here's the email.", approvals: [pending] }))).toBe(true);
    expect(waitsOnMember(reply({ content: "Here.", questions: [{ question: "Remote?", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false }] }))).toBe(true);
    // An answer already given, an answered card, an offer, a failure, or the member's own message: not news.
    expect(waitsOnMember(reply({ content: "Done. Both went out." }))).toBe(false);
    expect(waitsOnMember(reply({ content: "Here.", ui: [{ kind: "offer", id: "o", reason: "Talk?" }] }))).toBe(false);
    expect(waitsOnMember(reply({ content: "Here.", ui: [{ kind: "form", id: "f", title: "x", fields: [], submitLabel: "Send" }], uiResponse: { f: { status: "submitted", at: 1 } } }))).toBe(false);
    expect(waitsOnMember(reply({ status: "error", content: "Want to retry?" }))).toBe(false);
    expect(waitsOnMember(reply({ role: "user", content: "What now?" }))).toBe(false);
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

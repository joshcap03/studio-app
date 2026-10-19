import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/lib/agent/types";
import { callSummary, scoreCallTurn } from "./call-score";

// The call scorecard itself, offline: no flow, no model.

function turn(events: AgentEvent[], eventMs: number[], ms = 9000) {
  const reply = events.flatMap((e) => (e.type === "text-delta" ? [e.text] : [])).join("");
  return { events, eventMs, reply, ms };
}

const plan: AgentEvent = { type: "activity", id: "p", label: "Updating the plan", status: "running" };

describe("scoreCallTurn", () => {
  it("scores a short reply that asks one thing, read once the agent moves on to its books", () => {
    const s = scoreCallTurn(turn([{ type: "text-delta", text: "Got it, remote only. What's the one role you'd jump at?" }, plan], [2100, 2400]));
    expect(s).toMatchObject({ greeted: false, questions: 1, handsBack: true, restOnScreen: false, answerS: 2.4, booksFirst: false });
    expect(s.spokenWords).toBe(11);
  });

  it("catches a greeting, a stack of questions, books kept first, and a reply read only at the end", () => {
    const text = "Hey! Where do you live? What do you do? What pays the bills? Anything else on your mind today?";
    const s = scoreCallTurn(turn([plan, { type: "text-delta", text }], [800, 6000], 7000));
    expect(s).toMatchObject({ greeted: true, questions: 4, booksFirst: true, answerS: 7 });
    // The voice drops the greeting and asks one thing, the closing question; the rest is on screen.
    expect(s.spoken).toBe("The rest is on screen. Anything else on your mind today?");
  });

  it("counts a card as handing back the floor, even with no question in the reply", () => {
    const form = { form: { title: "Your bar", fields: [{ kind: "text", label: "What makes a role great?" }] } };
    const s = scoreCallTurn(turn([{ type: "text-delta", text: "Here's what I'd judge roles by." }, { type: "ui", block: form }], [1000, 1500]));
    expect(s.handsBack).toBe(true);
    expect(s.spoken).toMatch(/say “send” when it's right/);
  });

  it("catches a reply written again after the books, greeting partway", () => {
    const s = scoreCallTurn(turn([{ type: "text-delta", text: "What's been hardest?" }, plan, { type: "text-delta", text: "\n\nHey! Let's do this in steps. What's been hardest?" }], [900, 1200, 5000]));
    expect(s).toMatchObject({ greeted: true, wroteAgain: true, booksFirst: false, answerS: 1.2 });
    expect(s.spoken).toBe("Let's do this in steps. What's been hardest?");
  });

  it("flags a turn that leaves them on a silent line", () => {
    expect(scoreCallTurn(turn([{ type: "text-delta", text: "Saved that." }], [500])).handsBack).toBe(false);
  });

  it("counts a closing question with a hint after it as handing back the floor", () => {
    const s = scoreCallTurn(turn([{ type: "text-delta", text: "What does a right company look like to you? Think about the work, the stage, the people." }], [500]));
    expect(s).toMatchObject({ handsBack: true, questions: 1 });
  });

  it("sums up turns in one line", () => {
    const s = scoreCallTurn(turn([{ type: "text-delta", text: "Which city?" }], [500]));
    expect(callSummary([s, s])).toMatch(/^2 turns · spoken words p50 2.*hands back 2\/2/);
  });
});

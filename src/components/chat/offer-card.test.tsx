import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CallSummary, ChatMessage, UiOffer } from "@/lib/types";
import { callRecap } from "@/lib/voice/recap";
import { CallRecapCard } from "./call-recap";
import { OfferCard } from "./ui-cards";

// The agent's offer to call asks nothing and never rings: Call and Not now while it can be
// taken, a quiet line once it's answered or where it can't be (no calls for this member, an
// older reply). The recap after a call shows only what its records say.

const offer: UiOffer = { kind: "offer", id: "o1", reason: "This one's worth five minutes: three trade-offs to weigh.", topic: "Which offer to take" };
const render = (props: Partial<Parameters<typeof OfferCard>[0]>) =>
  renderToStaticMarkup(<OfferCard offer={offer} onAnswer={async () => undefined} {...props} />);

describe("OfferCard", () => {
  it("offers a call with the agent's reason, and a way to say not now", () => {
    const html = render({ onCall: async () => "s1" });
    expect(html).toContain("Hop on a call?");
    expect(html).toContain("three trade-offs to weigh");
    expect(html).toContain("Not now");
    expect(html).toContain(">Call<");
  });

  it("is a quiet line once answered, or where it can't be taken", () => {
    expect(render({ onCall: async () => "s1", response: { status: "accepted", at: 1, sessionId: "s1" } })).toContain("You took it");
    expect(render({ onCall: async () => "s1", response: { status: "declined", at: 1 } })).toContain("Not now");
    const inert = render({});
    expect(inert).toContain("Offered a call");
    expect(inert).not.toContain("Hop on a call?");
  });
});

describe("CallRecapCard", () => {
  it("shows what the call came to, with the job still out marked", () => {
    const call: CallSummary = { id: "c", startedAt: 0, endedAt: 240_000 };
    const base = { conversationId: "x", activity: [], artifacts: [], status: "complete" as const };
    const messages: ChatMessage[] = [
      { ...base, id: "u", role: "user", content: "Find remote roles", origin: { kind: "voice", sessionId: "c" }, createdAt: 1000 },
      { ...base, id: "r", role: "assistant", content: "", status: "streaming", activity: [{ id: "s", label: "Searched LinkedIn", status: "done", startedAt: 0 }], createdAt: 2000 },
    ];
    const html = renderToStaticMarkup(<CallRecapCard recap={callRecap(messages, call)!} />);
    expect(html).toContain("Call · 4 min");
    expect(html).toContain("“Find remote roles”");
    expect(html).toContain("Searched LinkedIn");
    expect(html).toContain("I&#x27;m still on it");
    expect(html).toContain("breathe-soft");
  });
});

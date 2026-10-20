import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Approval } from "@/lib/types";
import { ApprovalCard } from "./requests";

// The approval card on a call says how the request can be answered there, and only what's true:
// the read-back and "say send it" for a voice-ok request, a tap (and why) for any other, a tap
// for one whose spoken approval came back undecided, and the hold as it runs or waits for quiet.

const readBack = "I'll email jo@acme.example, saying “Hi Jo”.";
const voiceOk: Approval = { id: "a1", summary: "Email Jo", details: [], status: "pending", createdAt: 0, spoken: { ok: true, readBack } };
const render = (call: Parameters<typeof ApprovalCard>[0]["call"], approval: Approval = voiceOk) =>
  renderToStaticMarkup(<ApprovalCard approval={approval} onDecide={() => undefined} call={call} />);

describe("ApprovalCard on a call", () => {
  it("reads back a voice-ok request where spoken approvals are on", () => {
    const html = render({ spoken: true, hold: null });
    expect(html).toContain("Read back: I&#x27;ll email jo@acme.example");
    expect(html).toContain("Say “send it”, or tap.");
  });

  it("is a tap, with no read-back, once its spoken approval came back undecided", () => {
    const html = render({ spoken: true, spent: true, hold: null });
    expect(html).not.toContain("Read back:");
    expect(html).not.toContain("send it");
    expect(html).toContain("That one&#x27;s a tap now.");
  });

  it("is a tap where spoken approvals are off, or the request isn't voice-ok", () => {
    expect(render({ spoken: false, hold: null })).toContain("Approvals are taps for now.");
    expect(render({ spoken: true, hold: null }, { ...voiceOk, spoken: { ok: false, reason: "money" } })).toContain("Payments are a tap.");
  });

  it("shows the hold, and says when it's only waiting for quiet", () => {
    const running = render({ spoken: true, hold: { left: 0.5, onCancel: () => undefined } });
    expect(running).toContain("Approving");
    expect(running).toContain("Cancel");
    const waiting = render({ spoken: true, hold: { left: 0, waiting: true, onCancel: () => undefined } });
    expect(waiting).toContain("Waiting for quiet");
    expect(waiting).not.toContain(">Approving<");
  });
});

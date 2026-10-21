import { describe, expect, it } from "vitest";
import type { ChatMessage, MessageStatus, UiBlock } from "@/lib/types";
import { askOf, markOf, marksOf, moveFrom, moveOf, type LastMessage } from "./move";

function reply(patch: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "m", conversationId: "c", role: "assistant", content: "Here.", status: "complete", activity: [], artifacts: [], createdAt: 0, ...patch };
}

const form = { kind: "form", id: "f", title: "A few things", fields: [], submitLabel: "Send" } as UiBlock;
const proposal = { kind: "proposal", id: "p", summary: "How I'll work", skills: [], tasks: [], memories: [] } as UiBlock;
const merge = { kind: "memory-merge", id: "g", summary: "Facts to combine", merges: [] } as UiBlock;
// A card that asks nothing of them: the agent's offer to talk it through on a call.
const offer: UiBlock = { kind: "offer", id: "o", reason: "Quicker to talk it through." };
const question = { question: "Remote?", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false };
const pending = { id: "a", summary: "Send it", details: [] as [string, string][], status: "pending" as const, createdAt: 0 };

describe("askOf", () => {
  it("names what a reply still asks: a pending approval, then the first open card, then questions", () => {
    expect(askOf(reply())).toBeNull();
    expect(askOf(reply({ approvals: [pending], ui: [form] }))).toBe("approval");
    expect(askOf(reply({ approvals: [{ ...pending, status: "approved" }] }))).toBeNull();
    expect(askOf(reply({ ui: [form] }))).toBe("form");
    expect(askOf(reply({ ui: [proposal] }))).toBe("proposal");
    expect(askOf(reply({ ui: [merge] }))).toBe("merge");
    expect(askOf(reply({ ui: [{ kind: "browser", id: "h", reason: "Sign in." }] }))).toBe("browser");
    expect(askOf(reply({ ui: [{ kind: "browser", id: "h", reason: "Sign in." }], uiResponse: { h: { status: "handed-back", at: 1 } } }))).toBeNull();
    expect(askOf(reply({ questions: [question] }))).toBe("question");
    // In the order shown, skipping what's answered and what asks nothing.
    expect(askOf(reply({ ui: [offer, merge, proposal], uiResponse: { g: { status: "merged", at: 1, merges: [], skipped: 0 } } }))).toBe("proposal");
    expect(askOf(reply({ ui: [form], uiResponse: { f: { status: "submitted", at: 1 } }, questions: [question] }))).toBe("question");
    expect(askOf(reply({ ui: [offer] }))).toBeNull();
  });
});

describe("moveOf", () => {
  it("is working while a run goes on, whatever the last message says", () => {
    for (const status of ["complete", "error", "awaiting", "stopped"] as MessageStatus[]) {
      expect(moveOf(reply({ status }), { running: true })).toEqual({ move: "working" });
    }
    expect(moveOf(undefined, { running: true })).toEqual({ move: "working" });
    expect(moveOf(reply({ status: "streaming" }))).toEqual({ move: "working" });
  });

  it("is the member's call when an approval waits on them", () => {
    expect(moveOf(reply({ status: "awaiting", approvals: [pending] }))).toEqual({ move: "your_call", reason: "approval" });
    // Paused for one that's since been settled: nothing waits on them.
    expect(moveOf(reply({ status: "awaiting", approvals: [{ ...pending, status: "expired" }] }))).toEqual({ move: "idle" });
  });

  it("is the member's call when a finished reply ends on an open card or question", () => {
    expect(moveOf(reply({ ui: [form] }))).toEqual({ move: "your_call", reason: "form" });
    expect(moveOf(reply({ ui: [proposal] }))).toEqual({ move: "your_call", reason: "proposal" });
    expect(moveOf(reply({ ui: [merge] }))).toEqual({ move: "your_call", reason: "merge" });
    expect(moveOf(reply({ questions: [question] }))).toEqual({ move: "your_call", reason: "question" });
    // Answered, applied, or merged: done.
    expect(moveOf(reply({ ui: [proposal], uiResponse: { p: { status: "applied", at: 1, picks: { profile: true, instructions: false, skills: [], tasks: [], memories: [] }, applied: { settings: true, skills: 0, tasks: 0, memories: 0, skipped: 0 } } } }))).toEqual({
      move: "done",
    });
    // An offer to talk never makes it their call.
    expect(moveOf(reply({ ui: [offer] }))).toEqual({ move: "done" });
  });

  it("is the member's call when a task's run says it needs them, and done otherwise", () => {
    expect(moveOf(reply(), { report: { outcome: "needs_you", summary: "Pick a time" } })).toEqual({ move: "your_call", reason: "report" });
    expect(moveOf(reply({ ui: [form] }), { report: { outcome: "needs_you", summary: "" } })).toEqual({ move: "your_call", reason: "form" });
    expect(moveOf(reply(), { report: { outcome: "update", summary: "3 new" } })).toEqual({ move: "done" });
    expect(moveOf(reply(), { report: { outcome: "nothing_new", summary: "" } })).toEqual({ move: "done" });
    expect(moveOf(reply())).toEqual({ move: "done" });
  });

  it("is stuck when a run failed or was cut off, even with a card on it", () => {
    expect(moveOf(reply({ status: "error" }))).toEqual({ move: "stuck", reason: "failed" });
    expect(moveOf(reply({ status: "interrupted", ui: [form] }))).toEqual({ move: "stuck", reason: "failed" });
    expect(moveOf(reply({ status: "error" }), { report: { outcome: "needs_you", summary: "" } })).toEqual({ move: "stuck", reason: "failed" });
  });

  it("is idle when the member stopped it, wrote last, or there's nothing yet", () => {
    expect(moveOf(reply({ status: "stopped", ui: [form] }))).toEqual({ move: "idle" });
    expect(moveOf(reply({ role: "user" }))).toEqual({ move: "idle" });
    expect(moveOf(undefined)).toEqual({ move: "idle" });
  });

  it("reads the server's summary of a latest message the same way", () => {
    const last = (status: MessageStatus, ask: LastMessage["ask"] = null, role: LastMessage["role"] = "assistant"): LastMessage => ({ role, status, ask });
    expect(moveFrom(last("streaming"))).toEqual({ move: "working" });
    expect(moveFrom(last("awaiting", "approval"))).toEqual({ move: "your_call", reason: "approval" });
    expect(moveFrom(last("awaiting"))).toEqual({ move: "idle" });
    expect(moveFrom(last("complete", "proposal"))).toEqual({ move: "your_call", reason: "proposal" });
    expect(moveFrom(last("complete"))).toEqual({ move: "done" });
    expect(moveFrom(last("interrupted", "question"))).toEqual({ move: "stuck", reason: "failed" });
    expect(moveFrom(last("complete", null, "user"))).toEqual({ move: "idle" });
  });
});

describe("marks", () => {
  it("marks only working, the member's call, and stuck", () => {
    expect(markOf({ move: "working" })).toBe("working");
    expect(markOf({ move: "your_call", reason: "form" })).toBe("your_call");
    expect(markOf({ move: "stuck", reason: "failed" })).toBe("stuck");
    expect(markOf({ move: "done" })).toBeNull();
    expect(markOf({ move: "idle" })).toBeNull();
    expect(
      marksOf({
        a: { role: "assistant", status: "streaming", ask: null },
        b: { role: "assistant", status: "complete", ask: "form" },
        c: { role: "assistant", status: "error", ask: null },
        d: { role: "assistant", status: "complete", ask: null },
        e: { role: "assistant", status: "stopped", ask: null },
      }),
    ).toEqual({ a: "working", b: "your_call", c: "stuck" });
  });
});

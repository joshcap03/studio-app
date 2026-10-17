import { describe, expect, it } from "vitest";
import type { ChatMessage, ConversationSummary } from "@/lib/types";
import { excerpt, notificationFor } from "./push";

const conversation: ConversationSummary = { id: "c-1", title: "March invoices", projectId: null, createdAt: 0, updatedAt: 0 };

function reply(patch: Partial<ChatMessage>): ChatMessage {
  return { id: "m-1", conversationId: "c-1", role: "assistant", content: "", status: "complete", activity: [], artifacts: [], createdAt: 0, ...patch } as ChatMessage;
}

describe("notificationFor", () => {
  it("opens the conversation with the start of the reply", () => {
    expect(notificationFor(reply({ content: "## Done\n\nI sent **3 invoices** to [Acme](https://acme.test)." }), conversation)).toEqual({
      title: "March invoices",
      body: "Done I sent 3 invoices to Acme.",
      url: "/c/c-1",
      tag: "conversation:c-1",
    });
  });

  it("says what's waiting for the member's OK", () => {
    const awaiting = reply({
      status: "awaiting",
      approvals: [{ id: "a", summary: "Send the March invoice to jo@acme.test", details: [], status: "pending", createdAt: 0 }],
    });
    expect(notificationFor(awaiting, conversation)).toMatchObject({ title: "Needs your OK", body: "Send the March invoice to jo@acme.test" });
  });

  it("says when a run couldn't finish", () => {
    expect(notificationFor(reply({ status: "error" }), conversation)).toMatchObject({ title: "Couldn't finish", body: "March invoices" });
    expect(notificationFor(reply({ status: "interrupted" }), conversation)).toMatchObject({ title: "Couldn't finish" });
  });

  it("follows a task run's report: quiet when nothing's new, a nudge when it needs the member", () => {
    const done = reply({ content: "Checked your inbox." });
    expect(notificationFor(done, conversation, { outcome: "nothing_new", summary: "No replies" })).toBeNull();
    expect(notificationFor(done, conversation, { outcome: "needs_you", summary: "Pick a time for Acme's interview" })).toMatchObject({
      title: "Needs you",
      body: "Pick a time for Acme's interview",
    });
    expect(notificationFor(done, conversation, { outcome: "update", summary: "3 new roles" })).toMatchObject({ title: "March invoices", body: "3 new roles" });
    // A report never hides a failure.
    expect(notificationFor(reply({ status: "error" }), conversation, { outcome: "nothing_new", summary: "" })).toMatchObject({ title: "Couldn't finish" });
  });

  it("stays quiet when the member stopped it", () => {
    expect(notificationFor(reply({ status: "stopped" }), conversation)).toBeNull();
  });
});

describe("excerpt", () => {
  it("drops code blocks and cuts long text at a word", () => {
    const text = excerpt("Here:\n```\nsecret code\n```\n" + "word ".repeat(60), 40);
    expect(text).not.toContain("secret");
    expect(text.length).toBeLessThanOrEqual(41);
    expect(text.endsWith("…")).toBe(true);
  });
});

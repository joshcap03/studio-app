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

  it("comes from the agent by name once it has one", () => {
    expect(notificationFor(reply({ content: "Done." }), conversation, null, "Juniper")).toMatchObject({ title: "Juniper: March invoices" });
    const awaiting = reply({ status: "awaiting", approvals: [{ id: "a", summary: "Send it", details: [], status: "pending", createdAt: 0 }] });
    expect(notificationFor(awaiting, conversation, null, "Juniper")).toMatchObject({ title: "Juniper: Needs your OK" });
    expect(notificationFor(reply({ status: "error" }), conversation, null, null)).toMatchObject({ title: "Couldn't finish" });
  });

  it("says the agent left a voice note, opening on its play button", () => {
    const noted = reply({ id: "m-9", content: "## Roles\n\nThree cleared your bar.", voiceNote: { script: "Three roles cleared your **bar**. The best is remote.", source: "summary" } });
    expect(notificationFor(noted, conversation, { outcome: "update", summary: "Three roles cleared your bar." }, "Rowan")).toEqual({
      title: "Rowan left you a voice note",
      body: "Three roles cleared your bar. The best is remote.",
      url: "/c/c-1?play=m-9",
      tag: "conversation:c-1",
    });
    // Ahead of "Needs you": the note says what they need to do.
    expect(notificationFor(noted, conversation, { outcome: "needs_you", summary: "Pick one" }, "Rowan")).toMatchObject({ title: "Rowan left you a voice note" });
    // A reply to a voice message has no report.
    expect(notificationFor(noted, conversation, null, "June")).toMatchObject({ title: "June left you a voice note", url: "/c/c-1?play=m-9" });
    // A note never makes a quiet run loud, nor hides a failure.
    expect(notificationFor(noted, conversation, { outcome: "nothing_new", summary: "" }, "Rowan")).toBeNull();
    expect(notificationFor({ ...noted, status: "error" }, conversation, null, "Rowan")).toMatchObject({ title: "Rowan: Couldn't finish", url: "/c/c-1" });
  });

  it("says a reply that ends on a card or a question needs them, as the rail and the sidebar do", () => {
    const form = { kind: "form" as const, id: "f", title: "Your bar", fields: [], submitLabel: "Send" };
    expect(notificationFor(reply({ content: "A few things first.", ui: [form] }), conversation, null, "Rowan")).toMatchObject({
      title: "Rowan: Needs you",
      body: "A few things first.",
      url: "/c/c-1",
    });
    const question = { question: "Remote?", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false };
    expect(notificationFor(reply({ content: "One question.", questions: [question] }), conversation)).toMatchObject({ title: "Needs you" });
    // Ahead of a quiet run: it still waits on them.
    expect(notificationFor(reply({ content: "Which one?", questions: [question] }), conversation, { outcome: "nothing_new", summary: "" })).toMatchObject({ title: "Needs you" });
    // Once answered, it's just done.
    expect(notificationFor(reply({ content: "Thanks.", ui: [form], uiResponse: { f: { status: "submitted", at: 1 } } }), conversation)).toMatchObject({ title: "March invoices" });
    // A voice note still comes first: it says what they need to do.
    const noted = reply({ id: "m-9", content: "Which one?", questions: [question], voiceNote: { script: "Two fit. Which one?", source: "reply" } });
    expect(notificationFor(noted, conversation, null, "June")).toMatchObject({ title: "June left you a voice note", url: "/c/c-1?play=m-9" });
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

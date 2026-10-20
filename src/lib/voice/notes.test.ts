import { describe, expect, it } from "vitest";
import { MAX_VOICE_NOTE_CHARS, type ChatMessage, type MessageOrigin } from "@/lib/types";
import { noteCanCome, voiceNoteFor } from "./notes";

const message = (patch: Partial<ChatMessage>): ChatMessage => ({
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

const asked = (origin: MessageOrigin | null) => message({ id: "u1", role: "user", content: "Help me", origin });
const VOICE_MESSAGE: MessageOrigin = { kind: "voice", via: "note" };
const TASK: MessageOrigin = { kind: "task", taskId: "t1", title: "Job hunt", runId: "r1" };

describe("voiceNoteFor", () => {
  it("says the gist of a reply to a voice message, with the text underneath", () => {
    const reply = message({ content: "That's fixable. Let's find what to take first. Here's a [plan](https://x.test):\n\n- one\n- two" });
    expect(voiceNoteFor(reply, { answered: asked(VOICE_MESSAGE) })).toEqual({
      script: "That's fixable. Let's find what to take first. The rest is on screen.",
      source: "reply",
    });
    // The whole reply, said whole: nothing is "on screen" that wasn't said.
    expect(voiceNoteFor(message({ content: "Hey! Done. Two invoices went out." }), { answered: asked(VOICE_MESSAGE) })).toEqual({
      script: "Done. Two invoices went out.",
      source: "reply",
    });
  });

  it("says a task run's report when it brought something back, and the reply's gist when the report is empty", () => {
    const reply = message({ content: "## Roles\n\nI found **three** roles that clear your bar." });
    expect(voiceNoteFor(reply, { answered: asked(TASK), report: { outcome: "update", summary: "Three roles cleared your bar. The best is remote." } })).toEqual({
      script: "Three roles cleared your bar. The best is remote.",
      source: "summary",
    });
    expect(voiceNoteFor(reply, { answered: asked(TASK), report: { outcome: "needs_you", summary: "Pick a time with [Acme](https://acme.test)." } })).toEqual({
      script: "Pick a time with Acme.",
      source: "summary",
    });
    expect(voiceNoteFor(reply, { answered: asked(TASK), report: { outcome: "update", summary: "  " } })).toEqual({
      script: "Roles. I found three roles that clear your bar.",
      source: "reply",
    });
  });

  it("stays quiet for typing, calls, quiet runs, and replies that didn't finish", () => {
    const reply = message({ content: "Done." });
    expect(voiceNoteFor(reply, { answered: asked(null) })).toBeNull();
    expect(voiceNoteFor(reply, { answered: null })).toBeNull();
    expect(voiceNoteFor(reply, { answered: asked({ kind: "voice" }) })).toBeNull();
    expect(voiceNoteFor(reply, { answered: asked(TASK), report: { outcome: "nothing_new", summary: "No new replies" } })).toBeNull();
    expect(voiceNoteFor(reply, { answered: asked(TASK) })).toBeNull();
    for (const status of ["error", "stopped", "awaiting", "interrupted", "streaming"] as const) {
      expect(voiceNoteFor(message({ content: "Done.", status }), { answered: asked(VOICE_MESSAGE) })).toBeNull();
      expect(voiceNoteFor(message({ content: "Done.", status }), { answered: asked(TASK), report: { outcome: "update", summary: "News" } })).toBeNull();
    }
    // Nothing to say is no note.
    expect(voiceNoteFor(message({ content: "" }), { answered: asked(VOICE_MESSAGE) })).toBeNull();
    expect(voiceNoteFor(message({ content: "```\ncode\n```" }), { answered: asked(VOICE_MESSAGE) })).toBeNull();
  });

  it("says the gist of a reply to words said on a call when it finished after the call ended", () => {
    const reply = message({ content: "Three roles cleared your bar. The best is remote at 195." });
    const onCall = asked({ kind: "voice", sessionId: "s1" });
    expect(voiceNoteFor(reply, { answered: onCall, callEnded: true })).toEqual({ script: "Three roles cleared your bar. The best is remote at 195.", source: "reply" });
    // Still on the call: the call reads it out instead.
    expect(voiceNoteFor(reply, { answered: onCall, callEnded: false })).toBeNull();
    expect(voiceNoteFor(reply, { answered: onCall })).toBeNull();
    // Only a finished reply, and only one that answers the member's own spoken words.
    expect(voiceNoteFor(message({ content: "Three roles.", status: "error" }), { answered: onCall, callEnded: true })).toBeNull();
    expect(voiceNoteFor(reply, { answered: asked(null), callEnded: true })).toBeNull();
  });

  it("after an approval, says what the reply went on to say, not what the member read before deciding", () => {
    const earlier = "Here's the reminder I'll send Dana. It's waiting for your OK below.";
    const reply = message({ content: `${earlier}\n\nSent. Dana will get it in a minute.` });
    expect(voiceNoteFor(reply, { answered: asked(VOICE_MESSAGE), earlier })).toEqual({ script: "Sent. Dana will get it in a minute.", source: "reply" });
    // Declined, and nothing more said: nothing new to hear.
    expect(voiceNoteFor(message({ content: earlier }), { answered: asked(VOICE_MESSAGE), earlier })).toBeNull();
    // A task run's report still comes first; without one, the gist is of what came after.
    expect(voiceNoteFor(reply, { answered: asked(TASK), report: { outcome: "update", summary: "" }, earlier })).toEqual({
      script: "Sent. Dana will get it in a minute.",
      source: "reply",
    });
    // A reply rewritten whole once it carried on is said from its start.
    expect(voiceNoteFor(message({ content: "All sent." }), { answered: asked(VOICE_MESSAGE), earlier })).toEqual({ script: "All sent.", source: "reply" });
  });

  it("never says more than a note holds, cut at a word", () => {
    const summary = `${"word ".repeat(200)}end`;
    const note = voiceNoteFor(message({ content: "x" }), { answered: asked(TASK), report: { outcome: "update", summary } });
    expect([...note!.script].length).toBeLessThanOrEqual(MAX_VOICE_NOTE_CHARS);
    expect(note!.script.endsWith("word…")).toBe(true);
  });
});

describe("noteCanCome", () => {
  const CALL = "call-1";
  const thread = (origin: MessageOrigin | null, more: ChatMessage[] = []) => [asked(origin), message({ id: "r1", status: "streaming" }), ...more];

  it("is true only where the reply going now can come back as a note once the call hangs up", () => {
    // Words said on this call, a voice message, a task's run (a note if it turns something up).
    expect(noteCanCome(thread({ kind: "voice", sessionId: CALL }), CALL)).toBe(true);
    expect(noteCanCome(thread(VOICE_MESSAGE), CALL)).toBe(true);
    expect(noteCanCome(thread(TASK), CALL)).toBe(true);
    // Typing (joined by a call while it ran), another call's words, or a call's words before calls had ids.
    expect(noteCanCome(thread(null), CALL)).toBe(false);
    expect(noteCanCome(thread({ kind: "voice", sessionId: "call-2" }), CALL)).toBe(false);
    expect(noteCanCome(thread({ kind: "voice" }), CALL)).toBe(false);
    // The setup's opening has no words, so no origin; and nothing at all asked.
    expect(noteCanCome([message({ id: "u0", role: "user", content: "", skill: { id: "builtin:setup", name: "Setup" } }), message({ status: "streaming" })], CALL)).toBe(false);
    expect(noteCanCome([], CALL)).toBe(false);
  });

  it("goes by the member's latest message, the one a retry or a decision answers again", () => {
    const earlier = [asked({ kind: "voice", sessionId: CALL }), message({ id: "r0", content: "Found two." })];
    expect(noteCanCome([...earlier, message({ id: "u2", role: "user", content: "Typed", origin: null }), message({ id: "r2", status: "streaming" })], CALL)).toBe(false);
  });
});

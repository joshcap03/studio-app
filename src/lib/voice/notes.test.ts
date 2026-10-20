import { describe, expect, it } from "vitest";
import { MAX_VOICE_NOTE_CHARS, type ChatMessage, type MessageOrigin } from "@/lib/types";
import { voiceNoteFor } from "./notes";

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

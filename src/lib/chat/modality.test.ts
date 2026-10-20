import { describe, expect, it } from "vitest";
import { callOf, modalityOf, originFor } from "./modality";

describe("how a message was said", () => {
  it("labels spoken words by how they were said, and typed ones not at all", () => {
    expect(originFor("call", "Remote, senior")).toEqual({ kind: "voice" });
    // On a call that's known to be theirs, the call's id goes with it (for its recap).
    expect(originFor("call", "Remote, senior", "s1")).toEqual({ kind: "voice", sessionId: "s1" });
    expect(originFor("voice_note", "Hi", "s1")).toEqual({ kind: "voice", via: "note" });
    expect(originFor("voice_note", "Honestly I'm drowning")).toEqual({ kind: "voice", via: "note" });
    expect(originFor("text", "Hi")).toBeUndefined();
    expect(originFor(undefined, "Hi")).toBeUndefined();
    // A skill sent with no words wasn't said by anyone.
    expect(originFor("call", "  ")).toBeUndefined();
  });

  it("answers again the way the member said their message, whatever the browser sends", () => {
    expect(modalityOf({ kind: "voice", via: "note" })).toBe("voice_note");
    // Rows from before voice messages: plain voice is a call.
    expect(modalityOf({ kind: "voice" })).toBe("call");
    expect(modalityOf({ kind: "task", taskId: "t", title: "T", runId: null })).toBeUndefined();
    expect(modalityOf(null)).toBeUndefined();
    expect(modalityOf(undefined)).toBeUndefined();
    for (const modality of ["call", "voice_note"] as const) expect(modalityOf(originFor(modality, "Hi"))).toBe(modality);
    expect(modalityOf(originFor("call", "Hi", "s1"))).toBe("call");
  });

  it("names the call a message was said on", () => {
    expect(callOf({ kind: "voice", sessionId: "s1" })).toBe("s1");
    expect(callOf({ kind: "voice" })).toBeNull();
    expect(callOf({ kind: "voice", via: "note" })).toBeNull();
    expect(callOf({ kind: "task", taskId: "t", title: "T", runId: null })).toBeNull();
    expect(callOf(null)).toBeNull();
  });
});

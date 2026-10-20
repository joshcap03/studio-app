import { describe, expect, it } from "vitest";
import {
  clock,
  draftSpoken,
  heldGoesTo,
  HOLD_MS,
  insertWords,
  MAX_RECORDING_SECONDS,
  MIC_IDLE,
  micProblem,
  micReducer,
  NOTHING_CAUGHT,
  pressMode,
  recordingType,
  type MicEvent,
  type MicState,
} from "./mic";

function run(events: MicEvent[], from: MicState = MIC_IDLE): MicState {
  return events.reduce(micReducer, from);
}

describe("the message box's mic", () => {
  it("sends what's said while it's held, once it's let go", () => {
    expect(run([{ type: "press", at: 0 }, { type: "started", at: 80 }, { type: "release", at: 1500 }])).toEqual({ phase: "hearing", mode: "message" });
    expect(run([{ type: "press", at: 0 }, { type: "started", at: 100 }, { type: "release", at: 600 }])).toEqual({ phase: "hearing", mode: "message" });
  });

  it("never leaves the mic open when a hold is let go, even one the mic opened late for", () => {
    // Held a long time, but the mic only just opened (a headset, a cold start): nothing to send,
    // and no dictation the member didn't ask for.
    expect(run([{ type: "press", at: 0 }, { type: "started", at: 1900 }, { type: "release", at: 2000 }])).toEqual({ phase: "problem", message: NOTHING_CAUGHT });
    expect(run([{ type: "press", at: 0 }, { type: "started", at: 400 }, { type: "release", at: 650 }])).toEqual({ phase: "problem", message: NOTHING_CAUGHT });
  });

  it("dictates on a tap, until the next one", () => {
    const tapped = run([{ type: "press", at: 0 }, { type: "started", at: 80 }, { type: "release", at: HOLD_MS - 50 }]);
    expect(tapped).toMatchObject({ phase: "recording", down: false, mode: "dictation" });
    // Letting go again, or more time passing, doesn't end it.
    expect(run([{ type: "release", at: 5000 }, { type: "tick", at: 6000 }], tapped)).toEqual(tapped);
    expect(run([{ type: "press", at: 9000 }], tapped)).toEqual({ phase: "hearing", mode: "dictation" });
    // A tap right after the mic opened is still a tap.
    expect(run([{ type: "press", at: 0 }, { type: "started", at: 80 }, { type: "release", at: 250 }])).toMatchObject({ phase: "recording", mode: "dictation", down: false });
  });

  it("dictates from the keyboard, on and off", () => {
    const on = run([{ type: "toggle", at: 0 }, { type: "started", at: 50 }]);
    expect(on).toMatchObject({ phase: "recording", mode: "dictation", down: false });
    expect(run([{ type: "toggle", at: 4000 }], on)).toEqual({ phase: "hearing", mode: "dictation" });
    // A second press before the mic opened calls it off.
    expect(run([{ type: "toggle", at: 0 }, { type: "toggle", at: 100 }])).toEqual(MIC_IDLE);
  });

  it("dictates when let go before the mic opened (a permission prompt), or when the touch is taken away", () => {
    expect(run([{ type: "press", at: 0 }, { type: "release", at: 2000 }, { type: "started", at: 2500 }])).toMatchObject({ phase: "recording", mode: "dictation", down: false });
    expect(run([{ type: "press", at: 0 }, { type: "started", at: 50 }, { type: "interrupt" }])).toMatchObject({ phase: "recording", mode: "dictation", down: false });
  });

  it("drops the recording when slid away, cancelled, or a call takes the mic, and keeps it in the draft when the page hides", () => {
    expect(run([{ type: "press", at: 0 }, { type: "started", at: 50 }, { type: "cancel" }])).toEqual(MIC_IDLE);
    expect(run([{ type: "press", at: 0 }, { type: "cancel" }, { type: "started", at: 50 }])).toEqual(MIC_IDLE);
    expect(run([{ type: "press", at: 0 }, { type: "started", at: 50 }, { type: "hide" }])).toEqual({ phase: "hearing", mode: "dictation" });
    expect(run([{ type: "press", at: 0 }, { type: "hide" }])).toEqual(MIC_IDLE);
    // A call starting takes the mic: dictation under way stops, and nothing of the call is recorded.
    expect(run([{ type: "toggle", at: 0 }, { type: "started", at: 50 }, { type: "call" }])).toEqual(MIC_IDLE);
    expect(run([{ type: "toggle", at: 0 }, { type: "call" }])).toEqual(MIC_IDLE);
    expect(run([{ type: "call" }], { phase: "hearing", mode: "dictation" })).toEqual({ phase: "hearing", mode: "dictation" });
  });

  it("stops at the limit: a held message is sent, dictation goes into the draft", () => {
    const limit = MAX_RECORDING_SECONDS * 1000;
    expect(run([{ type: "press", at: 0 }, { type: "started", at: 0 }, { type: "tick", at: limit - 1 }])).toMatchObject({ phase: "recording" });
    expect(run([{ type: "press", at: 0 }, { type: "started", at: 0 }, { type: "tick", at: limit }])).toEqual({ phase: "hearing", mode: "message" });
    expect(run([{ type: "toggle", at: 0 }, { type: "started", at: 0 }, { type: "tick", at: limit }])).toEqual({ phase: "hearing", mode: "dictation" });
  });

  it("says what went wrong until it's dismissed, and starts again from there", () => {
    const failed = run([{ type: "press", at: 0 }, { type: "failed", message: "No microphone found." }]);
    expect(failed).toEqual({ phase: "problem", message: "No microphone found." });
    expect(run([{ type: "dismiss" }], failed)).toEqual(MIC_IDLE);
    expect(run([{ type: "press", at: 10 }], failed)).toMatchObject({ phase: "starting", down: true });
    expect(run([{ type: "heard" }], { phase: "hearing", mode: "message" })).toEqual(MIC_IDLE);
    // Nothing happens to a mic that's busy hearing.
    expect(run([{ type: "press", at: 0 }, { type: "release", at: 1 }, { type: "cancel" }], { phase: "hearing", mode: "message" })).toEqual({ phase: "hearing", mode: "message" });
  });

  it("tells a hold from a tap", () => {
    expect(pressMode(0, HOLD_MS)).toBe("message");
    expect(pressMode(0, HOLD_MS - 1)).toBe("dictation");
  });

  it("puts a held message in the draft while sending would redirect the agent, or with words or files already there", () => {
    expect(heldGoesTo({ redirects: false, draft: "", uploading: false })).toBe("send");
    // A run going, or an approval waiting: sending would stop it, or decline it.
    expect(heldGoesTo({ redirects: true, draft: "", uploading: false })).toBe("draft");
    expect(heldGoesTo({ redirects: false, draft: "Also ", uploading: false })).toBe("draft");
    expect(heldGoesTo({ redirects: false, draft: "  ", uploading: false })).toBe("send");
    expect(heldGoesTo({ redirects: false, draft: "", uploading: true })).toBe("draft");
  });

  it("sends a draft holding a held message as a voice message, until it's sent, cleared, or replaced", () => {
    // Held while the agent works: the words wait in the draft, and Send (or "Send now") still
    // sends what the member said, as said.
    const held = draftSpoken(false, { heldInto: "" });
    expect(held).toBe(true);
    expect(draftSpoken(held, { edited: "actually only remote roles" })).toBe(true);
    expect(draftSpoken(held, { edited: "  " })).toBe(false);
    expect(draftSpoken(held, { replaced: true })).toBe(false);
    // Held words joining typed ones, and dictation, are typing.
    expect(draftSpoken(false, { heldInto: "Also " })).toBe(false);
    expect(draftSpoken(false, { edited: "dictated words" })).toBe(false);
    expect(draftSpoken(held, { heldInto: "actually only remote roles" })).toBe(true);
  });

  it("puts dictated words where the caret is, spaced like typing", () => {
    expect(insertWords("", 0, 0, " find  three roles ")).toEqual({ value: "find three roles", caret: 16 });
    expect(insertWords("Please today.", 7, 7, "find roles")).toEqual({ value: "Please find roles today.", caret: 18 });
    expect(insertWords("Please", 6, 6, "find roles")).toEqual({ value: "Please find roles", caret: 17 });
    expect(insertWords("Hi there", 0, 0, "Well")).toEqual({ value: "Well Hi there", caret: 5 });
    expect(insertWords("Find roles.", 4, 4, "PM")).toEqual({ value: "Find PM roles.", caret: 7 });
    // A selection is replaced; a caret past the end goes at the end.
    expect(insertWords("Find old roles", 5, 8, "new")).toEqual({ value: "Find new roles", caret: 8 });
    expect(insertWords("Done", 99, 99, "now")).toEqual({ value: "Done now", caret: 8 });
    expect(insertWords("Done", 4, 4, "  ")).toEqual({ value: "Done", caret: 4 });
  });

  it("records Opus where it can", () => {
    expect(recordingType(() => true)).toBe("audio/webm;codecs=opus");
    expect(recordingType((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(recordingType(() => false)).toBe("");
  });

  it("says a refused or missing mic in plain words, and nothing for other failures", () => {
    expect(micProblem("NotAllowedError: Permission denied", "tap the mic again")).toContain("Allow it for this site");
    expect(micProblem("NotAllowedError: Permission denied", "tap the mic again")).toMatch(/then tap the mic again\.$/);
    expect(micProblem("NotFoundError: Requested device not found", "tap the mic again")).toBe("No microphone found. Connect one and tap the mic again.");
    expect(micProblem("AbortError: the device is busy", "tap the mic again")).toBeNull();
    expect(clock(0)).toBe("0:00");
    expect(clock(125.7)).toBe("2:05");
  });
});

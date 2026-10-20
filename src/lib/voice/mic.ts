// The message box's mic, as pure logic the composer drives (src/components/chat/mic.tsx). Holding
// it records a voice message, sent when it's let go; a short tap starts dictation, whose words go
// into the draft where the caret is, and a second tap stops it. Both start recording at the press,
// so the first word isn't lost while the browser decides which it was. Nothing here touches audio:
// the recording is turned into words on the server and the audio is dropped there.

/** A press held at least this long is a voice message; a shorter one is a tap. */
export const HOLD_MS = 300;

/** The longest recording, in seconds: a voice message is sent (and dictation stopped) here. */
export const MAX_RECORDING_SECONDS = 120;

/**
 * The largest recording the server takes, in bytes: two minutes at the most any browser's
 * recorder spends on speech (about 256 kbit/s). The mic asks for 32 kbit/s, far smaller.
 */
export const MAX_RECORDING_BYTES = 4 * 1024 * 1024;

/** A held voice message, or dictation into the draft. */
export type MicMode = "message" | "dictation";

export type MicState =
  | { phase: "idle" }
  /** The mic is opening (permission, the device); `down` while it's still held. */
  | { phase: "starting"; pressedAt: number; down: boolean; mode: MicMode | null }
  /** Recording; `mode` is null while it's held and could still be either. */
  | { phase: "recording"; pressedAt: number; startedAt: number; down: boolean; mode: MicMode | null }
  /** Recording is over and the words are on their way. */
  | { phase: "hearing"; mode: MicMode }
  | { phase: "problem"; message: string };

export type MicEvent =
  /** A finger or the mouse went down on the mic. */
  | { type: "press"; at: number }
  /** The keyboard (or an assistive tap): starts dictation, or stops it. */
  | { type: "toggle"; at: number }
  /** Let go on purpose. */
  | { type: "release"; at: number }
  /** Let go without meaning to (the browser took the touch, a permission prompt): keeps listening. */
  | { type: "interrupt" }
  | { type: "started"; at: number }
  | { type: "tick"; at: number }
  /** Slid away or Esc: the recording is dropped. */
  | { type: "cancel" }
  /** The page was hidden: what was said so far goes into the draft, never sent unseen. */
  | { type: "hide" }
  /**
   * A call started: the mic is the call's now, so the recording is dropped (the member says it on
   * the call; hearing it would also spend voice time the call holds).
   */
  | { type: "call" }
  | { type: "heard" }
  | { type: "failed"; message: string }
  | { type: "dismiss" };

export const MIC_IDLE: MicState = { phase: "idle" };

/** A recording with nothing in it. */
export const NOTHING_CAUGHT = "Didn't catch anything. Try again.";

export function micReducer(state: MicState, event: MicEvent): MicState {
  switch (event.type) {
    case "press":
    case "toggle": {
      const tap = event.type === "toggle";
      if (state.phase === "idle" || state.phase === "problem") {
        return { phase: "starting", pressedAt: event.at, down: !tap, mode: tap ? "dictation" : null };
      }
      // Dictation stops on the next tap; one that comes before the mic opened calls it off.
      if (state.phase === "recording" && !state.down && state.mode === "dictation") return { phase: "hearing", mode: "dictation" };
      if (state.phase === "starting" && !state.down) return MIC_IDLE;
      return state;
    }
    case "release":
      if (state.phase === "starting" && state.down) return { ...state, down: false, mode: "dictation" };
      if (state.phase === "recording" && state.down) {
        // A tap: dictation, until the next one.
        if (event.at - state.pressedAt < HOLD_MS) return { ...state, down: false, mode: "dictation" };
        // Held: a voice message, sent now, unless the mic opened too late to have caught anything.
        return event.at - state.startedAt >= HOLD_MS ? { phase: "hearing", mode: "message" } : { phase: "problem", message: NOTHING_CAUGHT };
      }
      return state;
    case "interrupt":
      return (state.phase === "starting" || state.phase === "recording") && state.down ? { ...state, down: false, mode: "dictation" } : state;
    case "started":
      return state.phase === "starting" ? { phase: "recording", pressedAt: state.pressedAt, startedAt: event.at, down: state.down, mode: state.mode } : state;
    case "tick":
      // Still held at the limit is a voice message.
      return state.phase === "recording" && event.at - state.startedAt >= MAX_RECORDING_SECONDS * 1000 ? { phase: "hearing", mode: state.mode ?? "message" } : state;
    case "cancel":
    case "call":
      return state.phase === "starting" || state.phase === "recording" ? MIC_IDLE : state;
    case "hide":
      if (state.phase === "recording") return { phase: "hearing", mode: "dictation" };
      return state.phase === "starting" ? MIC_IDLE : state;
    case "heard":
      return state.phase === "hearing" ? MIC_IDLE : state;
    case "failed":
      return { phase: "problem", message: event.message };
    case "dismiss":
      return state.phase === "problem" ? MIC_IDLE : state;
  }
}

/** Whether the mic is on (opening or recording). */
export function listening(state: MicState): state is Extract<MicState, { phase: "starting" | "recording" }> {
  return state.phase === "starting" || state.phase === "recording";
}

/** How long a press lasted: held (a voice message) or a tap (dictation). */
export function pressMode(pressedAt: number, releasedAt: number): MicMode {
  return releasedAt - pressedAt >= HOLD_MS ? "message" : "dictation";
}

/** Where a held voice message's words go once they're heard: sent, or into the draft for the member to send. */
export function heldGoesTo({ redirects, draft, uploading }: { redirects: boolean; draft: string; uploading: boolean }): "send" | "draft" {
  // While a run is going (or an approval waits), sending would redirect it: the member chooses
  // that with "Send now". Words already typed, or files still uploading, would be lost or left
  // behind, so the words join them.
  return redirects || uploading || draft.trim() ? "draft" : "send";
}

/**
 * Whether the draft goes as a voice message when the member sends it. Held words that went into
 * it, rather than being sent (sending then would have redirected the agent), keep it one until
 * it's sent, cleared, or replaced: the member only chose when it goes. Into words already typed,
 * held words join the typing; dictation is typing by voice.
 */
export function draftSpoken(
  spoken: boolean,
  change: /** Held words went into the draft as it was. */ { heldInto: string } | /** It changed to this. */ { edited: string } | { replaced: true },
): boolean {
  if ("heldInto" in change) return spoken || !change.heldInto.trim();
  if ("edited" in change) return spoken && change.edited.trim() !== "";
  return false;
}

/**
 * `words` put into `value` in place of the selection [start, end), with a space either side
 * where it needs one, and where the caret goes after them.
 */
export function insertWords(value: string, start: number, end: number, words: string): { value: string; caret: number } {
  const said = words.replace(/\s+/g, " ").trim();
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  if (!said) return { value, caret: to };
  const before = value.slice(0, from);
  const after = value.slice(to);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const tail = after && !/^[\s.,!?;:)]/.test(after) ? " " : "";
  return { value: `${before}${lead}${said}${tail}${after}`, caret: before.length + lead.length + said.length + tail.length };
}

/** The first recording format the browser can make, preferring small Opus; "" lets it choose. */
export function recordingType(supported: (type: string) => boolean): string {
  return ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"].find((t) => supported(t)) ?? "";
}

/** m:ss */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * A refused or missing microphone in plain words (the browser's own wording is just "Permission
 * denied"), ending on what to do `again`; null for any other failure.
 */
export function micProblem(message: string | undefined, again: string): string | null {
  const text = (message ?? "").trim();
  if (/permission|not ?allowed|denied/i.test(text)) {
    return `Studio couldn't use your microphone. Allow it for this site (the icon at the left of the address bar), then ${again}.`;
  }
  if (/not ?found|no (microphone|audio|device)|requested device/i.test(text)) return `No microphone found. Connect one and ${again}.`;
  return null;
}

import { isAffirmation, isApproveIntent, isBackchannel, isHoldOn, spokenWords } from "./intent";

// The call screen's guard on a spoken approval: what has to happen, in order, before the member's
// voice approves the request on screen, and what undoes it. The read-back is said in full (its
// words reach the voice, the voice speaks, and stops, with nothing cutting it off), then the
// member's first words after it are their spoken "send it" (the speech-to-text's, never typed),
// then a visible hold of HOLD_MS that anything they say, typing, hiding the tab, hanging up, a
// tap on Cancel, or the request leaving pending cancels, and that won't finish while they may
// still be talking (nor wait for quiet past HOLD_MAX_WAIT_MS: then it stops). Only then does it decide, once per request: a request approved by voice that
// comes back (the server refused it) is a tap from then on. Anything out of order fails closed:
// the read-back has to be said again. The server checks the words again (src/lib/voice/approvals.ts).
// Pure: the call screen feeds it what happens, with the time, and does what it says.

/** How long the visible hold runs before the approval goes. */
export const HOLD_MS = 3000;
/** The hold doesn't finish until the member has made no sound for this long: their words may still be coming. */
export const HOLD_QUIET_MS = 2000;
/**
 * How long past the hold it waits for that quiet. A room that never goes quiet (a TV, a fan)
 * stops the hold instead: it isn't sent, and a new "send it" is needed.
 */
export const HOLD_MAX_WAIT_MS = 5000;
/** An answer this soon after the read-back stopped was most likely said over its end. */
export const MIN_ANSWER_MS = 700;
/** Providers report a talk-over and the voice stopping in either order: one this soon after still cut the read-back off. */
export const CUT_OFF_MS = 1000;
/** Words matching what was typed this recently are the provider echoing them, not speech. */
export const TYPED_ECHO_MS = 3000;

/** The request on screen, as the guard sees it: `readBack` when this call may approve it by voice, null when it's a tap. */
export interface GuardRequest {
  id: string;
  readBack: string | null;
}

export type GuardPhase =
  /** Nothing waiting on them. */
  | "none"
  /** It's a tap: not voice-ok, or spoken approvals are off for this call. */
  | "tap"
  /** Not read back yet, or not heard in full. */
  | "unread"
  /** The voice is saying the read-back. */
  | "reading"
  /** Said in full; waiting for their answer. */
  | "read"
  /** Their yes is in; the hold is running. */
  | "holding"
  /** Approved by voice once: never again by voice. */
  | "sent";

export interface GuardState {
  request: GuardRequest | null;
  phase: GuardPhase;
  /** Reading: the voice has started speaking since the read-back's words arrived. */
  spoke: boolean;
  /** When the read-back stopped. */
  readAt: number | null;
  /** Read: the voice has said something else since, so a talk-over is about that. */
  later: boolean;
  /** The member's first words after the read-back, and whether they were typed. */
  answer: { words: string; typed: boolean; at: number } | null;
  holdUntil: number | null;
  /** When the member last made a sound (voice activity, talking over the voice). */
  soundAt: number;
  speakerOn: boolean;
  /** The voice's previous words, for a read-back that arrives in two parts; cleared when they weren't (all) heard. */
  lastVoice: string;
  /** Requests approved by voice on this call. */
  spent: string[];
  /** Requests whose spoken approval came back undecided, already said so. */
  returned: string[];
  /** What the member typed lately, in plain words. */
  typed: { words: string; at: number }[];
  /** Their last words, when they stopped a hold: what they said was about the hold, not the request. */
  heldOffBy: string | null;
}

export type GuardEvent =
  /** The request waiting on them now (null when none). */
  | { type: "request"; request: GuardRequest | null; at: number }
  /** Words the voice is saying (its own text, as the provider reports it). */
  | { type: "voice_text"; text: string; at: number }
  | { type: "mode"; mode: "speaking" | "listening"; at: number }
  /** The member talked over the voice, or the provider cut its words short. */
  | { type: "cut_off"; at: number }
  /** The member is making a sound (voice activity). */
  | { type: "sound"; at: number }
  | { type: "speaker"; on: boolean; at: number }
  /** Words from the member: the speech-to-text's, or `typed`. */
  | { type: "member"; text: string; typed: boolean; at: number }
  /** Their words were routed as a yes (send_card on the request): start the hold, if everything holds. */
  | { type: "approve"; at: number }
  /** A tap on Cancel, typing, the tab hidden, hanging up, the voice muted. */
  | { type: "cancel"; reason: "tap" | "typing" | "hidden" | "hang_up" | "speaker"; at: number }
  | { type: "tick"; at: number };

/** Why a yes didn't start the hold. `unread`: the read-back has to be said (again) first. */
export type GuardRefusal = "none" | "tap" | "spent" | "unread" | "typed" | "not_yes";

export type GuardEffect =
  | { kind: "hold"; requestId: string; until: number; words: string }
  | { kind: "refused"; reason: GuardRefusal }
  /** The hold stopped; `noisy` when it gave up waiting for quiet. */
  | { kind: "cancelled"; requestId: string; reason?: "noisy" }
  /** The hold finished: approve it now, with their words. */
  | { kind: "decide"; requestId: string; heard: string }
  /** A request approved by voice is waiting on them again: the approval didn't go through. */
  | { kind: "returned"; requestId: string };

export function initialGuard(): GuardState {
  return {
    request: null,
    phase: "none",
    spoke: false,
    readAt: null,
    later: false,
    answer: null,
    holdUntil: null,
    soundAt: 0,
    speakerOn: true,
    lastVoice: "",
    spent: [],
    returned: [],
    typed: [],
    heldOffBy: null,
  };
}

/** Back to not read: what was heard no longer counts. */
const unread = (s: GuardState): GuardState => ({ ...s, phase: s.request?.readBack ? "unread" : s.phase, spoke: false, readAt: null, later: false, answer: null, holdUntil: null, lastVoice: "" });

/** Whether `said` holds the read-back's words, in order (case, punctuation and quotes aside). */
export function saysReadBack(said: string, readBack: string): boolean {
  const want = spokenWords(readBack);
  return want.length > 0 && ` ${spokenWords(said)} `.includes(` ${want} `);
}

/** What one thing that happened does to the guard, and what the call screen should do about it. */
export function guardStep(state: GuardState, event: GuardEvent): { state: GuardState; effect?: GuardEffect } {
  const s = state;
  switch (event.type) {
    case "request": {
      const next = event.request;
      if (next?.id === s.request?.id && next?.readBack === s.request?.readBack) return { state: s };
      const cancelled: GuardEffect | undefined = s.phase === "holding" && s.request ? { kind: "cancelled", requestId: s.request.id } : undefined;
      const base: GuardState = { ...s, request: next, spoke: false, readAt: null, later: false, answer: null, holdUntil: null };
      if (!next) return { state: { ...base, phase: "none" }, effect: cancelled };
      if (s.spent.includes(next.id)) {
        // Approved by voice once, and waiting on them again: it didn't go through.
        const told = s.returned.includes(next.id);
        return { state: { ...base, phase: "sent", returned: told ? s.returned : [...s.returned, next.id] }, effect: told ? cancelled : { kind: "returned", requestId: next.id } };
      }
      return { state: { ...base, phase: next.readBack ? "unread" : "tap" }, effect: cancelled };
    }

    case "voice_text": {
      // Words said with the voice muted weren't heard, so they can't start a read-back either.
      const withText = { ...s, lastVoice: s.speakerOn ? event.text : "" };
      const readBack = s.request?.readBack;
      if (!readBack || (s.phase !== "unread" && s.phase !== "reading" && s.phase !== "read" && s.phase !== "holding")) return { state: withText };
      // The whole read-back in these words, or begun in the last ones (heard, and not all of it there already).
      const said = saysReadBack(event.text, readBack) || (!!s.lastVoice && !saysReadBack(s.lastVoice, readBack) && saysReadBack(`${s.lastVoice} ${event.text}`, readBack));
      if (said) {
        // Read back again: it starts over, and a hold already running stops (what they say next answers this one).
        const cancelled: GuardEffect | undefined = s.phase === "holding" ? { kind: "cancelled", requestId: s.request!.id } : undefined;
        if (!s.speakerOn) return { state: unread(withText), effect: cancelled };
        return { state: { ...withText, phase: "reading", spoke: false, readAt: null, later: false, answer: null, holdUntil: null }, effect: cancelled };
      }
      if (s.phase === "holding") return { state: withText };
      // Other words while the read-back is being said cut it short; after it, they're just later words.
      if (s.phase === "reading") return { state: unread(withText) };
      if (s.phase === "read") return { state: { ...withText, later: true } };
      return { state: withText };
    }

    case "mode": {
      if (s.phase === "reading") {
        if (event.mode === "speaking") return { state: { ...s, spoke: true } };
        return s.spoke ? { state: { ...s, phase: "read", readAt: event.at, later: false, answer: null } } : { state: s };
      }
      // Speaking again with nothing new said: the read-back only paused, and it isn't over yet.
      if (s.phase === "read" && event.mode === "speaking" && !s.later) return { state: { ...s, phase: "reading", spoke: true, readAt: null, answer: null } };
      return { state: s };
    }

    case "cut_off": {
      // What the voice was saying was cut off: it can't be the first part of a read-back either.
      const heard = { ...s, soundAt: event.at, lastVoice: "" };
      if (s.phase === "reading") return { state: unread(heard) };
      if (s.phase === "read" && !s.later && s.readAt !== null && event.at - s.readAt <= CUT_OFF_MS) return { state: unread(heard) };
      return { state: heard };
    }

    case "sound":
      return { state: { ...s, soundAt: Math.max(s.soundAt, event.at) } };

    case "speaker": {
      const next = { ...s, speakerOn: event.on, lastVoice: event.on ? s.lastVoice : "" };
      if (event.on) return { state: next };
      return guardStep(next, { type: "cancel", reason: "speaker", at: event.at });
    }

    case "member": {
      const words = spokenWords(event.text);
      const recent = s.typed.filter((t) => event.at - t.at <= TYPED_ECHO_MS);
      // Words just typed, coming back from the provider, are still typed.
      const typed = event.typed || recent.some((t) => t.words === words);
      const base: GuardState = {
        ...s,
        soundAt: typed ? s.soundAt : Math.max(s.soundAt, event.at),
        typed: event.typed ? [...recent, { words, at: event.at }] : recent,
        heldOffBy: words ? null : s.heldOffBy,
      };
      if (!words || (!typed && isBackchannel(event.text))) return { state: base };
      const noChange = isAffirmation(event.text) || isHoldOn(event.text);
      if (s.phase === "holding") {
        // Anything they say stops the hold; the read-back still counts, and what they said is their new answer.
        const cancelled: GuardEffect = { kind: "cancelled", requestId: s.request!.id };
        const read: GuardState = { ...base, phase: "read", answer: null, holdUntil: null, heldOffBy: event.text };
        return { state: noChange ? read : { ...read, answer: { words: event.text, typed, at: event.at } }, effect: cancelled };
      }
      if (s.phase === "reading") return { state: unread(base) };
      if (s.phase !== "read" || noChange) return { state: base };
      // An answer said over the read-back's end, or a second thing said after it (a change, a
      // question), means the read-back no longer stands on its own: it's said again first.
      if (s.answer || (s.readAt !== null && event.at - s.readAt < MIN_ANSWER_MS)) return { state: unread(base) };
      return { state: { ...base, answer: { words: event.text, typed, at: event.at } } };
    }

    case "approve": {
      const refuse = (reason: GuardRefusal, next = s) => ({ state: next, effect: { kind: "refused", reason } as GuardEffect });
      if (!s.request) return refuse("none");
      if (s.phase === "tap") return refuse("tap");
      if (s.phase === "sent" || s.spent.includes(s.request.id)) return refuse("spent");
      if (s.phase === "holding") return { state: s, effect: { kind: "hold", requestId: s.request.id, until: s.holdUntil!, words: s.answer!.words } };
      if (s.phase !== "read") return refuse("unread");
      if (!s.answer) return refuse("not_yes");
      // Typed words never approve. A typed "send it" asked nothing more, so their spoken one can still follow.
      if (s.answer.typed) return refuse("typed", isApproveIntent(s.answer.words) ? { ...s, answer: null } : s);
      if (!isApproveIntent(s.answer.words)) return refuse("not_yes", unread(s));
      const until = event.at + HOLD_MS;
      return { state: { ...s, phase: "holding", holdUntil: until }, effect: { kind: "hold", requestId: s.request.id, until, words: s.answer.words } };
    }

    case "cancel": {
      const cancelled: GuardEffect | undefined = s.phase === "holding" && s.request ? { kind: "cancelled", requestId: s.request.id } : undefined;
      // Hidden, hung up, or muted: they may not have heard it, so it's read again before a yes counts.
      if (event.reason === "hidden" || event.reason === "hang_up" || event.reason === "speaker") {
        return { state: s.phase === "reading" || s.phase === "read" || s.phase === "holding" ? unread(s) : s, effect: cancelled };
      }
      if (s.phase !== "holding") return { state: s };
      return { state: { ...s, phase: "read", answer: null, holdUntil: null }, effect: cancelled };
    }

    case "tick": {
      if (s.phase !== "holding" || !s.request || !s.answer || s.holdUntil === null) return { state: s };
      if (event.at < s.holdUntil) return { state: s };
      // It never went quiet in time (or the clock stalled): not sent, never late. The read-back
      // still stands; it takes a new yes.
      if (event.at >= s.holdUntil + HOLD_MAX_WAIT_MS) {
        return { state: { ...s, phase: "read", answer: null, holdUntil: null }, effect: { kind: "cancelled", requestId: s.request.id, reason: "noisy" } };
      }
      if (event.at - s.soundAt < HOLD_QUIET_MS) return { state: s };
      const id = s.request.id;
      return {
        state: { ...s, phase: "sent", holdUntil: null, spent: [...s.spent, id] },
        effect: { kind: "decide", requestId: id, heard: s.answer.words },
      };
    }
  }
}

/** Whether the hold has run out and is only waiting for quiet before it goes. */
export function waitingForQuiet(state: GuardState, now: number): boolean {
  return state.phase === "holding" && state.holdUntil !== null && now >= state.holdUntil;
}

/** How much of the hold is left, 0 to 1 (0 once it's only waiting for them to finish talking). */
export function holdLeft(state: GuardState, now: number): number {
  if (state.phase !== "holding" || state.holdUntil === null) return 0;
  return Math.max(0, Math.min(1, (state.holdUntil - now) / HOLD_MS));
}

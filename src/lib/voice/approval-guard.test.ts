import { describe, expect, it } from "vitest";
import {
  CUT_OFF_MS,
  guardStep,
  HOLD_MAX_WAIT_MS,
  HOLD_MS,
  HOLD_QUIET_MS,
  holdLeft,
  initialGuard,
  MIN_ANSWER_MS,
  saysReadBack,
  TYPED_ECHO_MS,
  type GuardEffect,
  type GuardEvent,
  type GuardRequest,
  type GuardState,
  waitingForQuiet,
} from "./approval-guard";
import { isAffirmation, isApproveIntent, isBackchannel, isHoldOn, spokenWords } from "./intent";
import { SAY_SEND_IT } from "./relay";

const REQUEST: GuardRequest = { id: "a1", readBack: "I'll email jo@acme.example, subject “March invoice”, saying “Hi Jo”." };
const OTHER: GuardRequest = { id: "a2", readBack: "I'll reply in the thread to sam@acme.example." };
const TAP: GuardRequest = { id: "a3", readBack: null };
const LINE = `${REQUEST.readBack} ${SAY_SEND_IT}`;

function run(events: GuardEvent[], start: GuardState = initialGuard()) {
  let state = start;
  const effects: GuardEffect[] = [];
  for (const event of events) {
    const out = guardStep(state, event);
    state = out.state;
    if (out.effect) effects.push(out.effect);
  }
  return { state, effects, last: effects.at(-1) };
}

// A call's events, each at its own time.
const req = (at: number, request: GuardRequest | null = REQUEST): GuardEvent => ({ type: "request", request, at });
const voice = (at: number, text = LINE): GuardEvent => ({ type: "voice_text", text, at });
const speaking = (at: number): GuardEvent => ({ type: "mode", mode: "speaking", at });
const listening = (at: number): GuardEvent => ({ type: "mode", mode: "listening", at });
const said = (at: number, text: string): GuardEvent => ({ type: "member", text, typed: false, at });
const typed = (at: number, text: string): GuardEvent => ({ type: "member", text, typed: true, at });
const approve = (at: number): GuardEvent => ({ type: "approve", at });
const tick = (at: number): GuardEvent => ({ type: "tick", at });
const cut = (at: number): GuardEvent => ({ type: "cut_off", at });
const cancel = (at: number, reason: Extract<GuardEvent, { type: "cancel" }>["reason"]): GuardEvent => ({ type: "cancel", reason, at });

/** The read-back said in full: its words, the voice speaking, then stopping at `doneAt`. */
const readBack = (doneAt: number, text = LINE): GuardEvent[] => [voice(doneAt - 4000, text), speaking(doneAt - 3900), listening(doneAt)];

/** Waiting on them, the read-back said by 1000, their "send it" at 3000, routed at 3200: holding until 6200. */
const holding = (): GuardEvent[] => [req(0), ...readBack(1000), said(3000, "Send it"), approve(3200)];

describe("approving by voice: the path that approves", () => {
  it("needs the read-back said in full, their spoken yes after it, then the hold, once", () => {
    const { effects, state } = run([...holding(), tick(4000), tick(6100), tick(6200)]);
    expect(effects).toEqual([
      { kind: "hold", requestId: "a1", until: 3200 + HOLD_MS, words: "Send it" },
      { kind: "decide", requestId: "a1", heard: "Send it" },
    ]);
    expect(state.phase).toBe("sent");
    // Once: no second decision, and no more yeses by voice for it.
    expect(run([tick(9000), approve(9100)], state).effects).toEqual([{ kind: "refused", reason: "spent" }]);
  });

  it("takes agreement and backchannels before the yes, and the voice's own later lines", () => {
    const { effects } = run([req(0), ...readBack(1000), said(2000, "mm-hm"), said(2500, "Yes."), voice(2600, SAY_SEND_IT), speaking(2700), listening(4000), said(5000, "Okay, send it"), approve(5100), tick(9000)]);
    expect(effects.map((e) => e.kind)).toEqual(["hold", "decide"]);
  });

  it("takes a read-back that paused partway, once it's really over", () => {
    const { effects } = run([req(0), voice(0), speaking(100), listening(800), speaking(900), listening(3000), said(4000, "send it"), approve(4100), tick(9000)]);
    expect(effects.map((e) => e.kind)).toEqual(["hold", "decide"]);
  });

  it("takes a read-back that arrives in two parts", () => {
    const cut = LINE.indexOf(" subject");
    const [first, second] = [LINE.slice(0, cut), LINE.slice(cut + 1)];
    const { effects } = run([req(0), voice(0, first), voice(10, second), speaking(100), listening(3000), said(4000, "send it"), approve(4100), tick(9000)]);
    expect(effects.map((e) => e.kind)).toEqual(["hold", "decide"]);
  });

  it("takes the read-back said again after something undid it", () => {
    const { effects } = run([req(0), ...readBack(1000), said(2000, "Change the subject"), said(3000, "send it"), approve(3100), ...readBack(9000), said(10_000, "send it"), approve(10_100), tick(15_000)]);
    expect(effects).toEqual([
      { kind: "refused", reason: "unread" },
      { kind: "hold", requestId: "a1", until: 10_100 + HOLD_MS, words: "send it" },
      { kind: "decide", requestId: "a1", heard: "send it" },
    ]);
  });
});

describe("approving by voice: the read-back has to be heard in full first", () => {
  it("refuses a yes with no read-back at all", () => {
    expect(run([req(0), said(1000, "send it"), approve(1100)]).last).toEqual({ kind: "refused", reason: "unread" });
  });

  it("refuses a yes said while it's being read back", () => {
    expect(run([req(0), voice(0), speaking(100), said(1500, "send it"), listening(1600), approve(1700)]).last).toEqual({ kind: "refused", reason: "unread" });
  });

  it("refuses a yes when they talked over the read-back, whichever order the provider reports it in", () => {
    expect(run([req(0), voice(0), speaking(100), cut(1500), listening(1500), said(3000, "send it"), approve(3100)]).last).toEqual({ kind: "refused", reason: "unread" });
    expect(run([req(0), voice(0), speaking(100), listening(1500), cut(1500 + CUT_OFF_MS), said(3000, "send it"), approve(3100)]).last).toEqual({ kind: "refused", reason: "unread" });
  });

  it("refuses a yes that came too soon after the read-back stopped to have been said after it", () => {
    expect(run([req(0), ...readBack(1000), said(1000 + MIN_ANSWER_MS - 1, "send it"), approve(2000)]).last).toEqual({ kind: "refused", reason: "unread" });
    expect(run([req(0), ...readBack(1000), said(1000 + MIN_ANSWER_MS, "send it"), approve(2000)]).last?.kind).toBe("hold");
  });

  it("refuses a yes before the voice has even started saying it", () => {
    expect(run([req(0), voice(0), listening(10), said(2000, "send it"), approve(2100)]).last).toEqual({ kind: "refused", reason: "unread" });
  });

  it("refuses a yes when the read-back was cut short by another line", () => {
    expect(run([req(0), voice(0), speaking(100), voice(500, "Okay."), listening(2000), said(3000, "send it"), approve(3100)]).last).toEqual({ kind: "refused", reason: "unread" });
  });

  it("refuses a yes when the read-back was only partly said", () => {
    expect(run([req(0), voice(0, LINE.slice(0, 40)), speaking(100), listening(2000), said(3000, "send it"), approve(3100)]).last).toEqual({ kind: "refused", reason: "unread" });
  });

  it("refuses a yes when the voice was muted while it read back, or the tab hidden after", () => {
    const muted: GuardEvent = { type: "speaker", on: false, at: 0 };
    expect(run([req(0), muted, ...readBack(1000), said(3000, "send it"), approve(3100)]).last).toEqual({ kind: "refused", reason: "unread" });
    expect(run([req(0), voice(0), speaking(100), { type: "speaker", on: false, at: 500 }, { type: "speaker", on: true, at: 600 }, listening(1000), said(3000, "send it"), approve(3100)]).last).toEqual({ kind: "refused", reason: "unread" });
    expect(run([req(0), ...readBack(1000), cancel(2000, "hidden"), said(3000, "send it"), approve(3100)]).last).toEqual({ kind: "refused", reason: "unread" });
  });

  it("refuses a yes after something else they said about it: the read-back no longer stands alone", () => {
    for (const change of ["Change the subject to April", "Who's it to?", "No", "and cc Sam"]) {
      expect(run([req(0), ...readBack(1000), said(2000, change), said(3000, "send it"), approve(3100)]).last, change).toEqual({ kind: "refused", reason: "unread" });
    }
  });

  it("refuses words that aren't a yes, and asks for the read-back again", () => {
    const { last, state } = run([req(0), ...readBack(1000), said(2000, "yes but later"), approve(2100)]);
    expect(last).toEqual({ kind: "refused", reason: "not_yes" });
    expect(state.phase).toBe("unread");
    expect(run([req(0), ...readBack(1000), approve(2100)]).last).toEqual({ kind: "refused", reason: "not_yes" });
  });
});

describe("approving by voice: only their spoken words count", () => {
  it("refuses typed words, and lets a spoken yes follow a typed one", () => {
    const { last, state } = run([req(0), ...readBack(1000), typed(2000, "send it"), approve(2100)]);
    expect(last).toEqual({ kind: "refused", reason: "typed" });
    const after = run([said(2000 + TYPED_ECHO_MS + 1, "send it"), approve(2000 + TYPED_ECHO_MS + 100), tick(11_000)], state);
    expect(after.effects.map((e) => e.kind)).toEqual(["hold", "decide"]);
  });

  it("takes the provider's echo of typed words as typed", () => {
    const { state } = run([req(0), ...readBack(1000), typed(2000, "send it"), approve(2100)]);
    expect(run([said(2500, "Send it."), approve(2600)], state).last).toEqual({ kind: "refused", reason: "typed" });
    // Long after, the same words said are speech.
    const later = run([said(2000 + TYPED_ECHO_MS + 1, "Send it."), approve(2000 + TYPED_ECHO_MS + 2)], state);
    expect(later.last?.kind).toBe("hold");
  });

  it("refuses a request that's a tap on this call, whatever is said", () => {
    expect(run([req(0, TAP), voice(0, "It needs your OK on screen: Pay Casting Co. Payments are a tap."), speaking(100), listening(1000), said(3000, "send it"), approve(3100)]).last).toEqual({
      kind: "refused",
      reason: "tap",
    });
    expect(run([approve(0)]).last).toEqual({ kind: "refused", reason: "none" });
  });
});

describe("the hold", () => {
  it("is cancelled by a tap, typing, the tab hiding, hanging up, or the voice muted", () => {
    for (const reason of ["tap", "typing", "hidden", "hang_up", "speaker"] as const) {
      const { effects } = run([...holding(), cancel(4000, reason), tick(9000)]);
      expect(effects.map((e) => e.kind), reason).toEqual(["hold", "cancelled"]);
    }
    expect(run([...holding(), { type: "speaker", on: false, at: 4000 }, tick(9000)]).effects.map((e) => e.kind)).toEqual(["hold", "cancelled"]);
  });

  it("is cancelled by anything they say or type, but not a backchannel", () => {
    for (const words of ["wait", "Yes", "stop", "change the subject", "no"]) {
      expect(run([...holding(), said(4000, words), tick(9000)]).effects.map((e) => e.kind), words).toEqual(["hold", "cancelled"]);
    }
    expect(run([...holding(), typed(4000, "ok"), tick(9000)]).effects.map((e) => e.kind)).toEqual(["hold", "cancelled"]);
    expect(run([...holding(), said(4000, "mm-hm"), tick(9000)]).effects.map((e) => e.kind)).toEqual(["hold", "decide"]);
  });

  it("is cancelled when the request stops waiting on them, or another takes its place", () => {
    expect(run([...holding(), req(4000, null), tick(9000)]).effects.map((e) => e.kind)).toEqual(["hold", "cancelled"]);
    expect(run([...holding(), req(4000, OTHER), tick(9000)]).effects.map((e) => e.kind)).toEqual(["hold", "cancelled"]);
    // Spoken approvals turned off for it.
    expect(run([...holding(), req(4000, { ...REQUEST, readBack: null }), tick(9000)]).effects.map((e) => e.kind)).toEqual(["hold", "cancelled"]);
  });

  it("after a tap on Cancel, the read-back still counts and a fresh yes starts it again", () => {
    const { effects } = run([...holding(), cancel(4000, "tap"), said(5000, "send it"), approve(5100), tick(5100 + HOLD_MS + HOLD_QUIET_MS)]);
    expect(effects.map((e) => e.kind)).toEqual(["hold", "cancelled", "hold", "decide"]);
  });

  it("after the tab hides or they hang up, the read-back is said again first", () => {
    for (const reason of ["hidden", "hang_up", "speaker"] as const) {
      const { effects } = run([...holding(), cancel(4000, reason), said(5000, "send it"), approve(5100)]);
      expect(effects.map((e) => (e.kind === "refused" ? e.reason : e.kind)), reason).toEqual(["hold", "cancelled", "unread"]);
    }
  });

  it("a yes said during it stops it and is their new answer", () => {
    const { effects } = run([...holding(), said(4000, "send it"), approve(4100), tick(9500)]);
    expect(effects.map((e) => e.kind)).toEqual(["hold", "cancelled", "hold", "decide"]);
  });

  it("runs its full length, and doesn't finish while they may still be talking", () => {
    expect(run([...holding(), tick(3200 + HOLD_MS - 1)]).effects.map((e) => e.kind)).toEqual(["hold"]);
    // A sound near the end: it waits for them to go quiet.
    const talking = run([...holding(), { type: "sound", at: 6000 }, tick(6200), tick(6000 + HOLD_QUIET_MS - 1)]);
    expect(talking.effects.map((e) => e.kind)).toEqual(["hold"]);
    expect(run([tick(6000 + HOLD_QUIET_MS)], talking.state).last?.kind).toBe("decide");
    // Talking over the voice counts as a sound too.
    const over = run([...holding(), cut(6100), tick(6200)]);
    expect(over.effects.map((e) => e.kind)).toEqual(["hold"]);
  });

  it("gives up when it never goes quiet: nothing is sent, and it takes a new yes", () => {
    const until = 3200 + HOLD_MS;
    // A steady sound (a TV, a fan) right through the hold and past it.
    const noise = Array.from({ length: 40 }, (_, i) => ({ type: "sound", at: 3300 + i * 250 }) as GuardEvent);
    const ticks = Array.from({ length: 60 }, (_, i) => tick(3300 + i * 200));
    const events = [...noise, ...ticks].sort((a, b) => a.at - b.at);
    const { effects, state } = run([...holding(), ...events]);
    expect(effects).toEqual([
      { kind: "hold", requestId: "a1", until, words: "Send it" },
      { kind: "cancelled", requestId: "a1", reason: "noisy" },
    ]);
    expect(state.phase).toBe("read");
    expect(state.spent).toEqual([]);
    // The routing of the same yes again doesn't restart it; a new spoken yes does.
    expect(run([approve(14000)], state).last).toEqual({ kind: "refused", reason: "not_yes" });
    const again = run([said(14000, "send it"), approve(14100), tick(14100 + HOLD_MS + HOLD_QUIET_MS)], state);
    expect(again.effects.map((e) => e.kind)).toEqual(["hold", "decide"]);
  });

  it("waits for quiet only so long, and says when it's waiting", () => {
    const until = 3200 + HOLD_MS;
    const talking = run([...holding(), { type: "sound", at: until + HOLD_MAX_WAIT_MS - 100 }, tick(until + 10)]);
    expect(waitingForQuiet(talking.state, until - 1)).toBe(false);
    expect(waitingForQuiet(talking.state, until + 10)).toBe(true);
    expect(run([tick(until + HOLD_MAX_WAIT_MS - 1)], talking.state).effects).toEqual([]);
    expect(run([tick(until + HOLD_MAX_WAIT_MS)], talking.state).last).toEqual({ kind: "cancelled", requestId: "a1", reason: "noisy" });
    // Quiet in time: it goes.
    const quiet = run([...holding(), { type: "sound", at: until + 1000 }, tick(until + 1000 + HOLD_QUIET_MS)]);
    expect(quiet.last?.kind).toBe("decide");
    expect(waitingForQuiet(initialGuard(), 0)).toBe(false);
  });

  it("remembers the words that stopped it, so they aren't taken as a no to the request", () => {
    const stopped = run([...holding(), said(4000, "cancel that")]);
    expect(stopped.last).toEqual({ kind: "cancelled", requestId: "a1" });
    expect(stopped.state.heldOffBy).toBe("cancel that");
    expect(stopped.state.phase).toBe("read");
    // Their next words aren't about the hold any more.
    expect(run([said(6000, "don't send it")], stopped.state).state.heldOffBy).toBeNull();
    // Words with no hold running stop nothing.
    expect(run([req(0), ...readBack(1000), said(3000, "cancel that")]).state.heldOffBy).toBeNull();
  });

  it("says how much of it is left", () => {
    const { state } = run(holding());
    expect(holdLeft(state, 3200)).toBe(1);
    expect(holdLeft(state, 3200 + HOLD_MS / 2)).toBeCloseTo(0.5);
    expect(holdLeft(state, 9999)).toBe(0);
    expect(holdLeft(initialGuard(), 0)).toBe(0);
  });

  it("answers a repeated routing of the same yes with the same hold", () => {
    expect(run([...holding(), approve(3300)]).effects).toEqual([
      { kind: "hold", requestId: "a1", until: 3200 + HOLD_MS, words: "Send it" },
      { kind: "hold", requestId: "a1", until: 3200 + HOLD_MS, words: "Send it" },
    ]);
  });
});

describe("after a spoken approval", () => {
  it("says once when it comes back undecided (the server refused it), and it's a tap from then on", () => {
    const sent = run([...holding(), tick(9000), req(9100, null)]).state;
    const back = run([req(9500), ...readBack(12_000), said(13_000, "send it"), approve(13_100), req(14_000, null), req(14_100)], sent);
    expect(back.effects).toEqual([
      { kind: "returned", requestId: "a1" },
      { kind: "refused", reason: "spent" },
    ]);
    expect(back.state.phase).toBe("sent");
  });

  it("leaves other requests to be approved by voice", () => {
    const sent = run([...holding(), tick(9000), req(9100, null)]).state;
    const next = run([req(10_000, OTHER), ...readBack(15_000, `${OTHER.readBack} ${SAY_SEND_IT}`), said(16_000, "go ahead"), approve(16_100), tick(21_000)], sent);
    expect(next.effects).toEqual([
      { kind: "hold", requestId: "a2", until: 16_100 + HOLD_MS, words: "go ahead" },
      { kind: "decide", requestId: "a2", heard: "go ahead" },
    ]);
  });

  it("ignores the same request reported again", () => {
    const { state } = run([req(0), ...readBack(1000)]);
    expect(guardStep(state, req(2000)).state).toBe(state);
  });
});

describe("saysReadBack", () => {
  it("matches the read-back's words in order, whatever the punctuation and quotes", () => {
    expect(saysReadBack(LINE, REQUEST.readBack!)).toBe(true);
    expect(saysReadBack(`Sure. ${LINE.replaceAll("“", '"').replaceAll("”", '"')}`, REQUEST.readBack!)).toBe(true);
    expect(saysReadBack("I'll email jo@acme.example.", REQUEST.readBack!)).toBe(false);
    expect(saysReadBack(LINE, "")).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------
// Everything at once: random calls, and what must be true of every approval the guard lets go.

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MEMBER_WORDS = ["send it", "Send it.", "yes", "go ahead", "mm-hm", "wait", "change the subject", "don't send it", "Yes, send it", "no", "okay"];
const VOICE_WORDS = [LINE, "Okay.", LINE.slice(0, 50), SAY_SEND_IT, `${OTHER.readBack} ${SAY_SEND_IT}`];
const REQUESTS = [REQUEST, REQUEST, REQUEST, OTHER, TAP, null];

function randomEvent(rand: () => number, at: number): GuardEvent {
  const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)];
  const kind = pick(["request", "voice", "voice", "speaking", "listening", "listening", "cut", "sound", "speaker", "said", "said", "said", "typed", "approve", "approve", "cancel", "tick", "tick", "tick"]);
  switch (kind) {
    case "request":
      return { type: "request", request: pick(REQUESTS), at };
    case "voice":
      return { type: "voice_text", text: pick(VOICE_WORDS), at };
    case "speaking":
    case "listening":
      return { type: "mode", mode: kind, at };
    case "cut":
      return { type: "cut_off", at };
    case "sound":
      return { type: "sound", at };
    case "speaker":
      return { type: "speaker", on: rand() < 0.6, at };
    case "said":
    case "typed":
      return { type: "member", text: pick(MEMBER_WORDS), typed: kind === "typed", at };
    case "approve":
      return { type: "approve", at };
    case "cancel":
      return { type: "cancel", reason: pick(["tap", "typing", "hidden", "hang_up", "speaker"] as const), at };
    default:
      return { type: "tick", at };
  }
}

/** Each way the guard's approval could be wrong, checked against the call's own record. Empty when it held. */
function violations(log: { event: GuardEvent; effects: GuardEffect[] }[], decideAt: number, decided: Extract<GuardEffect, { kind: "decide" }>): string[] {
  const out: string[] = [];
  const events = log.slice(0, decideAt + 1).map((l) => l.event);
  const decide = events[decideAt];
  // The hold that this decision ends, and the yes it started on.
  const holdAt = log.findLastIndex((l, i) => i < decideAt && l.effects.some((e) => e.kind === "hold"));
  if (holdAt < 0) return ["no hold"];
  const hold = log[holdAt].effects.find((e) => e.kind === "hold") as Extract<GuardEffect, { kind: "hold" }>;
  if (hold.requestId !== decided.requestId || hold.words !== decided.heard) out.push("decided other than held");
  const started = log.findIndex((l, i) => i <= holdAt && l.effects.some((e) => e.kind === "hold" && e.until === hold.until && e.requestId === hold.requestId));
  const approveEvent = events[started];
  if (decide.at < approveEvent.at + HOLD_MS) out.push("hold cut short");
  if (decide.at >= approveEvent.at + HOLD_MS + HOLD_MAX_WAIT_MS) out.push("waited for quiet past the cap");
  // The request: voice-ok, the same one throughout.
  const lastRequest = events.findLast((e): e is Extract<GuardEvent, { type: "request" }> => e.type === "request");
  if (!lastRequest?.request?.readBack || lastRequest.request.id !== decided.requestId) out.push("not the voice-ok request on screen");
  const readBackText = lastRequest?.request?.readBack ?? "";
  // A request event changes what's waiting only when it names another request, or another way of answering it.
  const changes = (i: number) => {
    const e = events[i];
    if (e.type !== "request") return false;
    const before = events.findLast((x, j): x is Extract<GuardEvent, { type: "request" }> => j < i && x.type === "request");
    return e.request?.id !== before?.request?.id || e.request?.readBack !== before?.request?.readBack;
  };
  // Nothing during the hold that should have stopped it.
  for (const [k, e] of events.slice(started + 1, decideAt).entries()) {
    if (e.type === "cancel") out.push(`cancel ${e.reason} ignored`);
    if (changes(started + 1 + k)) out.push("request changed during the hold");
    if (e.type === "speaker" && !e.on) out.push("muted during the hold");
    if (e.type === "member" && (e.typed || !isBackchannel(e.text))) out.push(`"${e.text}" during the hold ignored`);
  }
  const lastSound = events.slice(0, decideAt).reduce((t, e) => (e.type === "sound" || e.type === "cut_off" || (e.type === "member" && !e.typed) ? Math.max(t, e.at) : t), -Infinity);
  if (decide.at - lastSound < HOLD_QUIET_MS) out.push("finished while they were talking");
  // Their yes: spoken (not an echo of typing), a clear yes, after the read-back was said in full.
  const yesAt = events.findLastIndex((e, i) => i < started && e.type === "member" && e.text === hold.words);
  const yes = events[yesAt];
  if (!yes || yes.type !== "member") return [...out, "no yes"];
  if (yes.typed) out.push("typed yes");
  if (!isApproveIntent(yes.text)) out.push("not a yes");
  if (events.some((e, i) => i < yesAt && e.type === "member" && e.typed && spokenWords(e.text) === spokenWords(yes.text) && yes.at - e.at <= TYPED_ECHO_MS)) out.push("echo of typing");
  // Where the read-back was said: in one line, or completed by this one (not merely following one that said it all).
  const readAt = events.findLastIndex((e, i) => {
    if (i >= yesAt || e.type !== "voice_text") return false;
    const before = (events.slice(0, i).findLast((x) => x.type === "voice_text") as { text?: string } | undefined)?.text ?? "";
    return saysReadBack(e.text, readBackText) || (!saysReadBack(before, readBackText) && saysReadBack(`${before} ${e.text}`, readBackText));
  });
  if (readAt < 0) return [...out, "never read back"];
  const spoke = events.findIndex((e, i) => i > readAt && i < yesAt && e.type === "mode" && e.mode === "speaking");
  const stopped = spoke < 0 ? -1 : events.findIndex((e, i) => i > spoke && i < yesAt && e.type === "mode" && e.mode === "listening");
  if (stopped < 0) out.push("read-back not said to the end");
  for (const e of events.slice(readAt + 1, stopped < 0 ? yesAt : stopped)) if (e.type === "cut_off") out.push("read-back talked over");
  const speakerBefore = events.findLast((e, i) => i < readAt && e.type === "speaker") as Extract<GuardEvent, { type: "speaker" }> | undefined;
  if (speakerBefore && !speakerBefore.on) out.push("read back while muted");
  for (const [k, e] of events.slice(readAt + 1, yesAt).entries()) {
    if (changes(readAt + 1 + k)) out.push("request changed before the yes");
    if (e.type === "speaker" && !e.on) out.push("muted before the yes");
    if (e.type === "cancel" && e.reason !== "tap" && e.reason !== "typing") out.push(`${e.reason} before the yes`);
    // Agreeing, holding off, or a yes that a hold already took (and a tap stopped) adds nothing to what was read back.
    if (e.type === "member" && !(isBackchannel(e.text) && !e.typed) && !isAffirmation(e.text) && !isHoldOn(e.text) && !isApproveIntent(e.text)) {
      out.push(`"${e.text}" said between the read-back and the yes`);
    }
  }
  if (stopped >= 0 && yes.at - events[stopped].at < 0) out.push("yes before the read-back stopped");
  return out;
}

/**
 * A call that goes the way an approval does (the request, its read-back, a yes, the routing, the
 * hold), with anything else at all happening between the steps, at any pace.
 */
function* nearlyApproving(rand: () => number): Generator<(at: number) => GuardEvent> {
  const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)];
  const script: ((at: number) => GuardEvent)[] = [
    (at) => req(at),
    (at) => voice(at),
    (at) => speaking(at),
    (at) => listening(at),
    (at) => said(at, pick(["send it", "Yes, send it", "go ahead", "send it", "yes"])),
    (at) => approve(at),
    ...Array.from({ length: 8 }, () => (at: number) => tick(at)),
  ];
  for (const step of script) {
    const noise = rand() < 0.5 ? 0 : Math.floor(rand() * 3);
    for (let i = 0; i < noise; i++) yield (at) => randomEvent(rand, at);
    yield step;
  }
}

describe("the guard under any sequence of events", () => {
  it("never approves without a full read-back, a spoken yes after it, and an unbroken hold, and approves each request at most once", () => {
    const failures: string[] = [];
    let approvals = 0;
    for (let seed = 1; seed <= Number(process.env.GUARD_SEEDS ?? 6000); seed++) {
      const rand = prng(seed);
      let state = initialGuard();
      let at = 0;
      const log: { event: GuardEvent; effects: GuardEffect[] }[] = [];
      const decided = new Map<string, number>();
      // Half go nearly the way an approval does, perturbed; half are anything at all.
      const steps = seed % 2 ? [...nearlyApproving(rand)] : Array.from({ length: 60 }, () => (t: number) => randomEvent(rand, t));
      for (const make of steps) {
        at += Math.floor(rand() * 1800);
        const event = make(at);
        const out = guardStep(state, event);
        state = out.state;
        log.push({ event, effects: out.effect ? [out.effect] : [] });
        if (out.effect?.kind === "decide") {
          approvals++;
          decided.set(out.effect.requestId, (decided.get(out.effect.requestId) ?? 0) + 1);
          for (const v of violations(log, log.length - 1, out.effect)) failures.push(`seed ${seed}: ${v}`);
        }
      }
      for (const [id, n] of decided) if (n > 1) failures.push(`seed ${seed}: ${id} approved ${n} times`);
    }
    expect(failures.slice(0, 20)).toEqual([]);
    // The sequences do reach approvals, so the checks above aren't vacuous.
    expect(approvals).toBeGreaterThan(20);
  }, 300_000);

  it("never lets a tap-only request, or one with nothing waiting, start a hold", () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const rand = prng(seed * 7919);
      let state = initialGuard();
      let at = 0;
      for (let i = 0; i < 50; i++) {
        at += Math.floor(rand() * 1500);
        const event = randomEvent(rand, at);
        const before = state;
        const out = guardStep(state, event);
        state = out.state;
        if (out.effect?.kind === "hold") expect(before.request?.readBack, `seed ${seed}`).toBeTruthy();
        if (state.phase === "holding") expect(state.request?.readBack).toBeTruthy();
      }
    }
  });
});


"use client";

import { ArrowUp, AudioLines, Camera, Mic, MicOff, MonitorUp, PhoneOff, RotateCcw, Volume2, VolumeX } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCardDrafts, type FillResult } from "@/components/chat/card-drafts";
import { Markdown } from "@/components/chat/markdown";
import { ApprovalCard, QuestionCard } from "@/components/chat/requests";
import { UiCards } from "@/components/chat/ui-cards";
import { Journey } from "@/components/ui/journey";
import { moveOf } from "@/lib/chat/move";
import type { FormValues } from "@/lib/chat/ui-answer";
import { api, uploadAttachment, type SpokenDecision } from "@/lib/client/api";
import { guardStep, HOLD_MS, initialGuard, type GuardEffect, type GuardEvent, type GuardRequest } from "@/lib/voice/approval-guard";
import { isBackchannel, isDeclineIntent, isHoldOn, isLookIntent, isRedirect, isRetryIntent, isSendIntent, isStopIntent, longJobAnswer } from "@/lib/voice/intent";
import { clock, micProblem } from "@/lib/voice/mic";
import { CallNarrator } from "@/lib/voice/narrator";
import { noteCanCome } from "@/lib/voice/notes";
import { JUST_BACK } from "@/lib/voice/persona";
import { withHeldWords } from "@/lib/voice/recap";
import { approvalLine, tapReason, waitsOnMember } from "@/lib/voice/relay";
import { SETUP_JOURNEY_TITLE, type CallPurpose, type StageField, type VoiceGrant, type VoiceStage } from "@/lib/voice/types";
import { MAX_ATTACHMENTS, type Approval, type Attachment, type ChatMessage, type Journey as JourneyInfo, type StreamEvent, type UiField, type UiForm, type UiResponse } from "@/lib/types";
import type { LinkStatus, VoiceLink, VoiceLinkEvents, VoiceTools } from "./link";
import MockVoiceLink from "./mock-link";
import { Orb, ORB_LABEL, type OrbState } from "./orb";
import { BrowserView } from "./browser-view";
import { useShare } from "./share";

// A call with the agent, from any conversation: the orb (who has the floor, and whose move it is)
// beside the stage, which shows only what the backend reported: the journey rail, the latest
// reply, and the agent's own cards, answerable by tap or by voice. The voice is the agent's mouth
// and ears; the member's words go to the worker verbatim, its real progress is read out
// (relay.ts), and nothing is sent until they say "send" or tap. Talking over a running job is
// held for when it lands; only a clear "stop" or "actually…" redirects it, since that stops the
// work and declines any request waiting on them. A request waiting on their OK can be approved
// by voice where it's voice-ok: it's read back, their own spoken "send it" (never typed) starts
// a visible hold, and only then does it go (approval-guard.ts); a clear "don't send it" declines
// any request. The call can move to another conversation ("Do the first one now" follows the
// task's run), and a long job can end it with a voice note to come.

const ElevenLabsLink = dynamic(() => import("./elevenlabs-link"), { ssr: false });

export interface CallProps {
  grant: VoiceGrant;
  /** The agent's name, for the header ("Setting up Job search"). */
  agentName: string;
  /** The conversation the call is in now; it changes when the call follows a task's run. */
  conversationId: string;
  messages: ChatMessage[];
  running: boolean;
  /** The plan of the work on the call: the setup's when this call is the setup interview, else its conversation's. */
  journey: JourneyInfo | null;
  /** What the call is about, for the voice's bearings. */
  purpose: CallPurpose;
  /** Whether a reply can come back as a voice note, so a long job can offer one. */
  voiceNotes?: boolean;
  /** Answers the latest message again after its reply failed (Retry, or "try again"). */
  onRetry?: (messageId: string) => void;
  /** Sends the member's words (or a card's answer) as their next message, on the call. */
  onSend: (text: string, options: { steer: boolean; attachments?: Attachment[] }) => void;
  onStop: () => void;
  /** Answers the request waiting on them: by a tap, or `spoken` on this call (the server checks it again). */
  onDecide: (approvalId: string, decision: "approve" | "reject", spoken?: SpokenDecision) => void;
  onUiResponse: (messageId: string, blockId: string, response: UiResponse) => void;
  onRunTask?: (taskId: string) => Promise<void>;
  /** Streamed events of runs in this workspace, for narrating real progress. */
  subscribe: (listener: (conversationId: string, event: StreamEvent) => void) => () => void;
  /** The call is over; the chat takes it from here, with anything they said that was still held. */
  onEnd: (held: string[]) => void;
  /**
   * Opened without a tap on this page (arriving from onboarding): browsers may block a call's
   * sound until the member taps, so it waits for "Start call".
   */
  waitForTap?: boolean;
}

interface Caption {
  id: number;
  who: "you" | "voice";
  text: string;
}

const AFTER_SPEECH_MS = 900;
/** Studio's lines wait this long after the member last sounded like they were speaking. */
const AFTER_MEMBER_MS = 900;
/** Longest the first lines wait for the greeting to be said. */
const GREETING_WAIT_MS = 6000;

/** The request waiting on the member's OK: on the latest reply, paused for it. */
function waitingApproval(messages: ChatMessage[], running: boolean): Approval | undefined {
  const reply = messages.findLast((m) => m.role === "assistant");
  return !running && reply?.status === "awaiting" ? reply.approvals?.find((a) => a.status === "pending") : undefined;
}

/** Said when a request approved by voice is waiting on them again: the server didn't take it. */
const NOT_THROUGH = "That didn't go through, so it's still waiting on you. It's a tap now.";
/** The hold gave up waiting for a pause: nothing was sent. */
const NO_PAUSE = "I couldn't hear a clear pause, so I haven't sent it. Say “send it” again, or tap Approve.";

/** The open card on the latest reply: a form not yet sent, questions not yet answered. */
function openAsk(messages: ChatMessage[], running: boolean) {
  const reply = messages.at(-1);
  if (!reply || reply.role !== "assistant" || running || reply.status !== "complete") return { reply: null, form: null, questions: null };
  const form = (reply.ui ?? []).find((b): b is UiForm => b.kind === "form" && !reply.uiResponse?.[b.id]) ?? null;
  return { reply, form, questions: reply.questions?.length ? reply.questions : null };
}

function fieldNow(field: UiField, value: FormValues[string] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (field.kind === "verdict" && Array.isArray(value)) {
    const calls = value as Record<string, string>[];
    return field.items
      .map((item, i) => {
        const call = calls.find((c) => c.id === item.id);
        return call?.verdict ? `${call.verdict === "keep" ? "Keep" : "Pass"} ${i + 1}` : null;
      })
      .filter(Boolean)
      .join(", ") || undefined;
  }
  if (field.kind === "list" && Array.isArray(value)) return `${(value as Record<string, string>[]).filter((e) => Object.values(e).some((v) => v?.trim())).length} filled in`;
  if (field.kind === "rank" && Array.isArray(value)) return (value as string[]).join(" > ");
  const text = Array.isArray(value) ? (value as string[]).join(", ") : String(value);
  return text.trim() ? (text.length > 160 ? `${text.slice(0, 157)}…` : text) : undefined;
}

function stageField(field: UiField, value: FormValues[string] | undefined): StageField {
  const base: StageField = { id: field.id, label: field.label, kind: field.kind, required: field.required, current: fieldNow(field, value) };
  switch (field.kind) {
    case "choice":
    case "multi_choice":
    case "rank":
      return { ...base, options: field.options.map((o) => o.label) };
    case "verdict":
      return { ...base, items: field.items.map((item, i) => ({ n: i + 1, id: item.id, title: item.title })), reasons: field.reasons };
    case "scale":
      return { ...base, scale: { steps: field.steps, low: field.low, high: field.high } };
    case "file":
    case "connect":
      return { ...base, tapOnly: true, current: undefined };
    default:
      return base;
  }
}

/** A short, soft tone to connect and to hang up; the only sounds on a call. */
function tone(rising: boolean) {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(rising ? 520 : 600, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(rising ? 660 : 440, ctx.currentTime + 0.16);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.24);
    osc.onended = () => void ctx.close();
  } catch {
    // no audio here; the call works without it
  }
}

/**
 * A tool argument as the model sent it: structured answers arrive as JSON text (the provider's
 * tool schemas only carry strings), plain answers as text.
 */
function argument(value: unknown): unknown {
  if (typeof value !== "string" || !/^\s*[[{]/.test(value)) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** What a fill did, for the voice to say. */
function fillReply(result: FillResult): string {
  if (result.status === "refused") return `Refused: ${result.reason}`;
  return result.status === "filled" ? `Filled: ${result.said}. Not sent yet.` : `Heard: ${result.said}? It's on screen for them to confirm with a tap.`;
}

/** How long the call screen stays up after hanging up while the job is still out, to say so. */
const OUT_ON_IT_MS = 1400;
/** The longest the call waits for its voice-note line to be said before it hangs up anyway. */
const NOTE_LINE_WAIT_MS = 6000;

/** A call failure in plain words; the browser's own wording for a refused mic is just "Permission denied". */
export function callProblem(message: string | undefined): string {
  const text = (message ?? "").trim();
  return micProblem(text, "start the call again") ?? (text ? `${text.replace(/[.!]?$/, ".")}` : "The call dropped.");
}

export function Call({
  grant,
  agentName,
  conversationId,
  messages,
  running,
  journey,
  purpose,
  voiceNotes = false,
  onRetry,
  onSend,
  onStop,
  onDecide,
  onUiResponse,
  onRunTask,
  subscribe,
  onEnd,
  waitForTap = false,
}: CallProps) {
  const drafts = useCardDrafts();
  // What they show the call (their screen or camera), kept on their device until they ask it to look.
  const share = useShare({ mock: !grant.capabilities.audio });
  const shareRef = useRef(share);
  shareRef.current = share;
  /** Snapshots waiting to go with their next words: taken while the agent worked, or with Snap. */
  const filesRef = useRef<Attachment[]>([]);
  const [snapped, setSnapped] = useState(0);
  const [snapping, setSnapping] = useState(false);
  /** The agent has used its browser in this conversation during the call: watch it (view only). */
  const [browsing, setBrowsing] = useState(false);
  const [joined, setJoined] = useState(!waitForTap);
  const link = useRef<VoiceLink | null>(null);
  const [status, setStatus] = useState<LinkStatus>("connecting");
  const [problem, setProblem] = useState<string | null>(null);
  const [mode, setMode] = useState<"speaking" | "listening">("listening");
  const [mic, setMic] = useState(true);
  const [speaker, setSpeaker] = useState(true);
  const [away, setAway] = useState(false);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [held, setHeld] = useState<string[]>([]);
  const [onIt, setOnIt] = useState(false);
  const [progressSeen, setProgressSeen] = useState(false);
  const [typed, setTyped] = useState("");
  const [elapsed, setElapsed] = useState(0);
  /** The call asked "hang on, or a voice note?" about the job going now, and they haven't said. */
  const [longJob, setLongJob] = useState(false);
  const longJobRef = useRef(false);
  longJobRef.current = longJob;
  /** When the job came back while that question was open: an answer arriving just after isn't for the worker. */
  const longJobClosedAt = useRef<number | null>(null);
  /** The question about waiting is over: answered, or the job came back (`closed`). */
  const closeLongJob = useCallback((closed = false) => {
    if (closed && longJobRef.current) longJobClosedAt.current = Date.now();
    longJobRef.current = false;
    setLongJob(false);
  }, []);
  /** Hung up while the job is still going: the orb says it's out on it, then the chat takes over. */
  const [closing, setClosing] = useState(false);
  /** They chose a voice note: the call hangs up once the voice has said so. */
  const noteExit = useRef<{ at: number; heard: boolean } | null>(null);
  const captionId = useRef(0);

  // What the member said on this call, verbatim, and how much of it has been acted on.
  const spoken = useRef<string[]>([]);
  /** Which of those they typed rather than said: typed words never approve a request. */
  const typedAt = useRef(new Set<number>());
  const consumed = useRef(0);
  /** Where the words about the card now on screen begin. */
  const cardSince = useRef(0);
  const heldRef = useRef<string[]>([]);
  heldRef.current = held;

  // What the call says, each sentence once a turn, waiting until the floor is free.
  const [narrator] = useState(() => new CallNarrator());
  const lastSpeechAt = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const ended = useRef(false);
  /** When the greeting was cued; Studio's lines wait until it's been said, so they don't cut it off. */
  const greetingAt = useRef<number | null>(null);
  const greeted = useRef(false);
  const memberSoundAt = useRef(0);
  /** A redirect stopped the run before this one; its "Stopped" isn't news. */
  const steered = useRef(false);

  const live = useRef({ messages, running, conversationId });
  live.current = { messages, running, conversationId };

  // ---------------------------------------------------------------------------------------
  // Spoken approvals: the guard (approval-guard.ts) hears what happens on the call and says when
  // a request may go, after its read-back, the member's spoken "send it", and the hold.

  /** Whether this call may approve a voice-ok request by voice, as the server said when it started. */
  const spokenOn = grant.spokenApprovals === true;
  const guard = useRef(initialGuard());
  /** The hold running before a spoken approval goes, and the clock it's drawn by. */
  const [approving, setApproving] = useState<{ id: string; until: number } | null>(null);
  const [holdNow, setHoldNow] = useState(0);
  /** Requests whose spoken approval on this call came back undecided: taps from then on, on screen and aloud. */
  const [spent, setSpent] = useState<readonly string[]>([]);
  const decideRef = useRef(onDecide);
  decideRef.current = onDecide;
  const step = useCallback(
    (event: GuardEvent): GuardEffect | undefined => {
      const out = guardStep(guard.current, event);
      if (out.state.spent !== guard.current.spent) setSpent(out.state.spent);
      guard.current = out.state;
      const effect = out.effect;
      if (effect?.kind === "hold") {
        setApproving({ id: effect.requestId, until: effect.until });
        setHoldNow(Date.now());
      } else if (effect?.kind === "cancelled") {
        setApproving(null);
        if (effect.reason === "noisy") narrator.aside(NO_PAUSE);
      } else if (effect?.kind === "decide") {
        setApproving(null);
        setOnIt(true);
        setProgressSeen(false);
        decideRef.current(effect.requestId, "approve", { via: "voice", heard: effect.heard, voiceSessionId: grant.sessionId });
      } else if (effect?.kind === "returned") {
        narrator.aside(NOT_THROUGH);
      }
      return effect;
    },
    [grant.sessionId, narrator],
  );

  const pendingApproval = waitingApproval(messages, running);
  const request: GuardRequest | null = pendingApproval
    ? { id: pendingApproval.id, readBack: spokenOn && pendingApproval.spoken?.ok ? pendingApproval.spoken.readBack : null }
    : null;
  const requestRef = useRef(request);
  requestRef.current = request;
  const requestKey = request ? `${request.id}:${request.readBack ?? ""}` : "";
  // The request leaving pending (answered, expired, declined by a change of course) stops a hold.
  useEffect(() => {
    step({ type: "request", request: requestRef.current, at: Date.now() });
  }, [requestKey, step]);

  // The hold's clock: drawn as it runs, and done once it's run out and they've gone quiet.
  useEffect(() => {
    if (!approving) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setHoldNow(now);
      step({ type: "tick", at: now });
    }, 100);
    return () => clearInterval(timer);
  }, [approving, step]);

  const ask = openAsk(messages, running);
  const questionsKey = ask.reply ? `${ask.reply.id}:questions` : "";
  const latestReply = messages.findLast((m) => m.role === "assistant");

  const stage = useMemo<VoiceStage>(() => {
    const draft = ask.form ? drafts.form(ask.form) : null;
    const proposal = ask.reply?.ui?.find((b) => b.kind === "proposal" && !ask.reply!.uiResponse?.[b.id]);
    const steps = journey?.steps ?? [];
    const at = steps.findIndex((s) => s.status === "doing" || s.status === "needs_you");
    const current = steps[at >= 0 ? at : steps.findIndex((s) => s.status !== "done")]?.text ?? null;
    return {
      working: running,
      purpose,
      ...(steps.length
        ? {
            journey: {
              done: steps.filter((s) => s.status === "done").length,
              total: steps.length,
              current,
              ...(journey?.goal ? { goal: journey.goal } : {}),
              // Always said, so the voice can tell this from a page that predates kinds (the setup's).
              ...(journey ? { kind: journey.kind } : {}),
            },
          }
        : {}),
      ...(ask.form && draft && !draft.sent ? { form: { id: ask.form.id, title: ask.form.title, fields: ask.form.fields.map((f) => stageField(f, draft.values[f.id])) } } : {}),
      ...(ask.questions && !drafts.question(questionsKey, ask.questions).sent
        ? { questions: ask.questions.map((q) => ({ question: q.question, options: q.options.map((o) => o.label), multi: q.multiSelect })) }
        : {}),
      ...(proposal && proposal.kind === "proposal" ? { proposal: proposal.summary } : {}),
      ...(pendingApproval
        ? {
            approval: pendingApproval.summary,
            ...(tapReason(pendingApproval, spokenOn, spent) ? { approvalTap: tapReason(pendingApproval, spokenOn, spent)! } : { approvalVoice: true }),
            ...(approving?.id === pendingApproval.id ? { approving: true } : {}),
          }
        : {}),
      ...(longJob && running ? { longJob: true } : {}),
      ...(share.kind ? { sharing: share.kind } : {}),
    };
  }, [approving, ask.form, ask.questions, ask.reply, drafts, journey, longJob, pendingApproval, purpose, questionsKey, running, share.kind, spent, spokenOn]);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  /** The stage the voice last heard, with a line or as an update. */
  const sentStage = useRef("");

  const caption = useCallback((who: Caption["who"], text: string) => {
    captionId.current += 1;
    const id = captionId.current;
    setCaptions((list) => [...list.slice(-5), { id, who, text }]);
  }, []);

  // ---------------------------------------------------------------------------------------
  // Ending

  // Words still held for a job that hasn't landed go back to the chat with it (into its message
  // box), never lost. A job still going when they hang up is out on it: the screen says so for a
  // moment, and the sidebar keeps breathing by its name.
  const finished = useRef(false);
  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    onEnd(heldRef.current);
  }, [onEnd]);
  const hangUp = useCallback(
    (sound = true) => {
      if (ended.current) return;
      step({ type: "cancel", reason: "hang_up", at: Date.now() });
      ended.current = true;
      noteExit.current = null;
      link.current?.end();
      if (sound) tone(false);
      api.endVoice(grant.sessionId).catch(() => undefined);
      if (live.current.running) {
        setClosing(true);
        setTimeout(finish, OUT_ON_IT_MS);
      } else {
        finish();
      }
    },
    [finish, grant.sessionId, step],
  );

  // Leaving the page (or this screen going away) ends the call, so its time stops counting.
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // React may mount this twice in development; only a real unmount ends the call.
    if (leaving.current) clearTimeout(leaving.current);
    leaving.current = null;
    const url = `/api/voice/session/${grant.sessionId}/end`;
    const onLeave = () => {
      if (!ended.current) navigator.sendBeacon(url);
    };
    window.addEventListener("pagehide", onLeave);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      leaving.current = setTimeout(() => {
        if (ended.current) return;
        ended.current = true;
        api.endVoice(grant.sessionId).catch(() => undefined);
      }, 0);
    };
  }, [grant.sessionId]);

  // ---------------------------------------------------------------------------------------
  // The client tools: each checks the member's own words before it acts, and says what happened.

  const pending = () => spoken.current.slice(consumed.current).filter((w) => !isBackchannel(w));
  const consume = () => {
    consumed.current = spoken.current.length;
  };
  const lastWords = () => spoken.current.at(-1) ?? "";
  /** Whether their last words were typed, not said. */
  const lastTyped = () => typedAt.current.has(spoken.current.length - 1);

  /**
   * Their "send it" to the request waiting on them, routed here by the voice front's fixed rule:
   * the hold starts only if the guard says everything before it held; otherwise the reason, in a
   * word the voice front turns into fixed words (and the read-back is said again when it must be).
   */
  const approveByVoice = (approval: Approval): string => {
    consume();
    const effect = step({ type: "approve", at: Date.now() });
    if (effect?.kind === "hold") return "Approving: in three seconds, unless they say wait or tap Cancel.";
    switch (effect?.kind === "refused" ? effect.reason : "none") {
      case "unread":
      case "not_yes":
        narrator.again(approvalLine(approval, true));
        return "Reading: it's read back first; then their own spoken “send it” counts.";
      case "typed":
        return "Tap: typed";
      case "spent":
        return "Tap: spent";
      case "tap":
        return `Tap: ${tapReason(approval, spokenOn, guard.current.spent) ?? "unsupported"}`;
      default:
        return "Refused: there's no request waiting on them.";
    }
  };
  const cardWords = () => spoken.current.slice(cardSince.current).join(" ");

  /** The member's next message, with anything they said while the agent was busy. */
  const withHeld = useCallback((text: string) => {
    const earlier = heldRef.current.join(" ");
    if (!earlier) return text;
    setHeld([]);
    heldRef.current = [];
    return withHeldWords(text, earlier);
  }, []);
  /** Words for when the current work lands; kept in step at once, since a hang-up can come before the next render. */
  const hold = useCallback((words: string) => {
    heldRef.current = [...heldRef.current, words];
    setHeld(heldRef.current);
  }, []);

  const send = useCallback(
    (text: string, options: { steer: boolean; attachments?: Attachment[] }) => {
      setOnIt(true);
      setProgressSeen(false);
      steered.current = options.steer && live.current.running;
      // Snapshots waiting for their words go with them.
      const files = filesRef.current;
      filesRef.current = [];
      setSnapped(0);
      const attachments = [...(options.attachments ?? []), ...files].slice(0, MAX_ATTACHMENTS);
      onSend(text, attachments.length ? { ...options, attachments } : options);
    },
    [onSend],
  );

  /** One frame of what they're sharing, uploaded like any file; null when it couldn't be taken. */
  const snapshot = useCallback(async (): Promise<Attachment | null> => {
    setSnapping(true);
    try {
      const file = await shareRef.current.snap();
      return file ? await uploadAttachment(file) : null;
    } catch {
      return null;
    } finally {
      setSnapping(false);
    }
  }, []);
  /** Snap: a frame that goes with whatever they say or type next. */
  const snapNow = useCallback(async () => {
    const taken = await snapshot();
    if (!taken) return;
    filesRef.current = [...filesRef.current, taken].slice(-MAX_ATTACHMENTS);
    setSnapped(filesRef.current.length);
  }, [snapshot]);

  const handOff = useCallback((): string => {
    const said = pending();
    const words = said.join(" ").trim();
    if (!words) return "Refused: they haven't said anything new to pass on.";
    consume();
    const { running: busy, messages: now } = live.current;
    const last = now.at(-1);
    const awaiting = last?.status === "awaiting";
    // "Try again" after a reply failed tries it again, rather than sending the words.
    if (!busy && onRetry && last?.role === "assistant" && (last.status === "error" || last.status === "interrupted") && isRetryIntent(words)) {
      setOnIt(true);
      setProgressSeen(false);
      onRetry(last.id);
      return "Handed off: trying it again.";
    }
    // Their answer to "hang on, or a voice note?": the call ends once that's said, or carries
    // on. Anything said before it is talk-over like any other. An answer that comes just as the
    // job did has nothing to wait for and no note coming (the call is still on, and reads it).
    const long = longJobAnswer(said, { open: longJobRef.current, running: busy, closedAt: longJobClosedAt.current, now: Date.now() });
    if (long) {
      longJobClosedAt.current = null;
      closeLongJob();
      if (long.earlier) {
        if (busy || awaiting) hold(long.earlier);
        else send(withHeld(long.earlier), { steer: false });
      }
      if (long.late) return "Done: it just came back, so there's nothing to wait for; what it came to comes next.";
      if (long.answer === "wait") return "Waiting: they'll hang on while it works.";
      noteExit.current = { at: Date.now(), heard: modeRef.current === "speaking" };
      return "Ending: they'd rather have a voice note when it's done; the call ends once that's said.";
    }
    // "Look at this" while they share: one frame goes with their words (the reply waits for it, so
    // the tool answers at once). While the agent works, both wait for it like any talk-over.
    if (shareRef.current.kind && isLookIntent(words)) {
      const steer = (busy || awaiting) && isRedirect(words);
      if ((busy || awaiting) && !steer) hold(words);
      void snapshot().then((taken) => {
        if (taken) filesRef.current = [...filesRef.current, taken].slice(-MAX_ATTACHMENTS);
        setSnapped(filesRef.current.length);
        if (steer) send(words, { steer: true });
        else if (!(busy || awaiting)) send(withHeld(words), { steer: false });
      });
      if ((busy || awaiting) && !steer) return awaiting ? "Held: it's waiting on their OK on screen; their words and a snapshot go along after." : "Held: until the current work lands, with a snapshot.";
      return "Handed off: looking at what they're showing.";
    }
    if (busy || awaiting) {
      if (isRedirect(words)) {
        send(words, { steer: true });
        return awaiting
          ? "Handed off: their change of course. The request that was waiting on their OK was declined."
          : "Handed off: their change of course. The earlier work stopped.";
      }
      hold(words);
      return awaiting ? "Held: it's waiting on their OK on screen; their words go along after." : "Held: until the current work lands.";
    }
    send(withHeld(words), { steer: false });
    return "Handed off: sent to the worker.";
  }, [closeLongJob, hold, onRetry, send, snapshot, withHeld]);

  const tools: VoiceTools = {
    send_message: () => handOff(),
    stop_work: () => {
      const said = lastWords();
      // A clear no to the request waiting on them declines it (which changes nothing outside),
      // said or typed; only said words are kept as theirs.
      const approval = waitingApproval(live.current.messages, live.current.running);
      // "Cancel that" during the hold stopped the hold (the guard saw to that), not the request.
      if (approval && guard.current.heldOffBy === said && isHoldOn(said)) {
        consume();
        return "Held off: the hold stopped; the request is still waiting on them.";
      }
      if (approval && isDeclineIntent(said)) {
        consume();
        step({ type: "cancel", reason: "tap", at: Date.now() });
        onDecide(approval.id, "reject", lastTyped() ? undefined : { via: "voice", heard: said, voiceSessionId: grant.sessionId });
        return "Declined: the request that was waiting on their OK.";
      }
      if (isRedirect(said)) return handOff();
      if (!isStopIntent(said)) return "Refused: they didn't ask to stop.";
      consume();
      if (!live.current.running) return "Refused: nothing is running.";
      onStop();
      return "Stopped: the current work.";
    },
    fill_card: (params) => {
      const { form } = openAsk(live.current.messages, live.current.running);
      if (!form) return live.current.running ? "Refused: no card yet; the worker is still busy." : "Refused: there's no card open on screen.";
      const result = drafts.fillForm(form, { field: String(params.field ?? ""), value: argument(params.value), sure: params.sure === false ? false : undefined }, cardWords());
      if (result.status !== "refused") consume();
      return fillReply(result);
    },
    answer_question: (params) => {
      const { reply, questions } = openAsk(live.current.messages, live.current.running);
      if (!reply || !questions) return "Refused: there's no question open on screen.";
      const result = drafts.fillQuestion(`${reply.id}:questions`, questions, argument(params.answers));
      if (result.status !== "refused") consume();
      return fillReply(result);
    },
    send_card: async () => {
      // The voice front sends their "send it" to a request waiting on them here, by rule.
      const approval = waitingApproval(live.current.messages, live.current.running);
      if (approval) return approveByVoice(approval);
      if (!isSendIntent(lastWords())) return "Refused: wait until they say send.";
      const { reply, form, questions } = openAsk(live.current.messages, live.current.running);
      if (!reply) return "Refused: there's no card open on screen.";
      consume();
      if (form) {
        const error = await drafts.submitForm({
          form,
          conversationId: live.current.conversationId,
          messageId: reply.id,
          onAnswer: (text, extras) => send(withHeld(text), { steer: false, attachments: extras.attachments }),
          onResponse: onUiResponse,
        });
        return error ? `Refused: ${error}` : `Sent: ${form.title}.`;
      }
      if (questions) {
        const error = drafts.submitQuestions(`${reply.id}:questions`, questions, (text) => send(withHeld(text), { steer: false }));
        return error ? `Refused: ${error}` : "Sent: their answers.";
      }
      if (reply.ui?.some((b) => b.kind === "proposal")) return "Refused: the proposed setup is applied with a tap on screen.";
      if (reply.ui?.some((b) => b.kind === "memory-merge")) return "Refused: merging facts is done with a tap on screen.";
      return "Refused: there's no card open on screen.";
    },
  };
  const toolsRef = useRef(tools);
  toolsRef.current = tools;

  // ---------------------------------------------------------------------------------------
  // Events from the voice

  const events: VoiceLinkEvents = {
    onStatus: (next, message) => {
      if (ended.current) return;
      setStatus(next);
      if (next === "connected") {
        tone(true);
        greetingAt.current = Date.now();
        sentStage.current = JSON.stringify(stageRef.current);
        link.current?.cue("hello", stageRef.current);
      } else if (next === "ended") {
        hangUp();
      } else if (next === "error") {
        setProblem(callProblem(message));
        api.endVoice(grant.sessionId).catch(() => undefined);
      }
    },
    onMode: (next) => {
      step({ type: "mode", mode: next, at: Date.now() });
      // The first time the voice finishes speaking after the cue, the greeting has been said.
      if (next === "listening" && modeRef.current === "speaking" && greetingAt.current !== null) greeted.current = true;
      if (next === "speaking" && noteExit.current) noteExit.current.heard = true;
      setMode(next);
      modeRef.current = next;
      lastSpeechAt.current = Date.now();
    },
    onVoiceActivity: (score) => {
      if (score <= 0.6) return;
      memberSoundAt.current = Date.now();
      step({ type: "sound", at: memberSoundAt.current });
    },
    onMemberText: (text, { typed }) => {
      if (typed) typedAt.current.add(spoken.current.length);
      spoken.current.push(text);
      caption("you", text);
      step({ type: "member", text, typed, at: Date.now() });
    },
    onVoiceText: (text) => {
      caption("voice", text);
      step({ type: "voice_text", text, at: Date.now() });
    },
    onInterrupted: () => {
      lastSpeechAt.current = Date.now();
      step({ type: "cut_off", at: lastSpeechAt.current });
    },
  };

  // Real progress from the worker, as it reports it.
  useEffect(
    () =>
      subscribe((id, event) => {
        if (id !== live.current.conversationId || ended.current) return;
        narrator.event(event, Date.now());
        if (event.type === "activity" && !event.step.hidden) setProgressSeen(true);
        if (event.type === "activity" && event.step.app === "browser") setBrowsing(true);
        // A new job is going: an answer to the question about the last one is talk-over now.
        if (event.type === "start") longJobClosedAt.current = null;
        if (event.type === "end") {
          closeLongJob(true);
          // It came back before the call hung up for its voice note: the call is still on, so no
          // note will come (src/lib/voice/notes.ts). It stays on and reads it instead.
          if (noteExit.current) {
            noteExit.current = null;
            narrator.aside(JUST_BACK);
          }
          if (steered.current && event.message.status === "stopped") {
            steered.current = false;
            return;
          }
          // Words held while it worked go along with their next message when it asks for one,
          // and on their own otherwise; then the question this reply ends on is already behind
          // them, and the next reply asks what's next.
          const asksNow = Boolean(event.message.questions?.length || event.message.ui?.some((b) => b.kind === "form"));
          const passOn = heldRef.current.length > 0 && !asksNow && event.message.status !== "awaiting";
          narrator.reply(event.message, { superseded: passOn, spokenApprovals: spokenOn, spent: guard.current.spent });
          setOnIt(false);
          cardSince.current = spoken.current.length;
          if (passOn) {
            const words = heldRef.current.join(" ");
            setHeld([]);
            heldRef.current = [];
            setTimeout(() => !ended.current && send(words, { steer: false }), 400);
          }
        }
      }),
    [closeLongJob, narrator, send, spokenOn, subscribe],
  );

  // Picking up where it left off: once connected and the conversation is loaded, what's waiting
  // on them now (a reply that asks something or ends on a question; an older answer isn't news).
  // A call that starts a new turn hears about it as the turn goes.
  const caughtUp = useRef(false);
  useEffect(() => {
    if (caughtUp.current || status !== "connected" || (!messages.length && !running)) return;
    caughtUp.current = true;
    const last = messages.at(-1);
    if (last && !running && waitsOnMember(last)) narrator.reply(last, { spokenApprovals: spokenOn, spent: guard.current.spent });
  }, [messages, narrator, running, spokenOn, status]);

  // What finishing each journey step gave the agent. When the call moves to another conversation,
  // its plan is that conversation's own, not a change to the one before.
  const plan = journey?.steps ?? null;
  const lastPlan = useRef(plan);
  const planOf = useRef(conversationId);
  useEffect(() => {
    if (plan && lastPlan.current && planOf.current === conversationId) narrator.journey(lastPlan.current, plan);
    lastPlan.current = plan;
    planOf.current = conversationId;
  }, [conversationId, narrator, plan]);

  // Following into another conversation: what's said from here is about the card there.
  const boundTo = useRef(conversationId);
  useEffect(() => {
    if (boundTo.current === conversationId) return;
    boundTo.current = conversationId;
    cardSince.current = spoken.current.length;
    longJobClosedAt.current = null;
    closeLongJob();
  }, [closeLongJob, conversationId]);

  // A job that ended (or a question left unanswered when it did) closes the question about waiting.
  useEffect(() => {
    if (!running) closeLongJob(true);
  }, [closeLongJob, running]);

  // The voice's view of the stage, kept current. Not again when a line just carried it: an update
  // arriving while the voice words a line makes the provider drop that line.
  const stageJson = JSON.stringify(stage);
  useEffect(() => {
    if (status !== "connected" || stageJson === sentStage.current) return;
    sentStage.current = stageJson;
    link.current?.stage(JSON.parse(stageJson) as VoiceStage);
  }, [stageJson, status]);

  // Saying queued lines: never over the voice itself, and progress at a calm pace.
  useEffect(() => {
    const timer = setInterval(() => {
      if (status !== "connected" || ended.current || !link.current) return;
      const now = Date.now();
      // They chose a voice note: hang up once the voice has said it would leave one.
      const going = noteExit.current;
      if (going) {
        if (modeRef.current === "speaking") going.heard = true;
        else if (going.heard ? now - lastSpeechAt.current > AFTER_SPEECH_MS : now - going.at > NOTE_LINE_WAIT_MS) hangUp();
        return;
      }
      // Never over the greeting, the voice itself, or the member mid-sentence.
      if (!greeted.current && greetingAt.current !== null && now - greetingAt.current < GREETING_WAIT_MS) return;
      if (modeRef.current === "speaking" || now - lastSpeechAt.current < AFTER_SPEECH_MS || now - memberSoundAt.current < AFTER_MEMBER_MS) return;
      // A job that's gone a while with nothing new: ask once whether to hang on or leave a voice
      // note, only when its reply really can come back as one (never for a run started by typing).
      const noteable = voiceNotes && noteCanCome(live.current.messages, grant.sessionId);
      if (narrator.longJob(now, live.current.running && noteable)) {
        const next: VoiceStage = { ...stageRef.current, longJob: true };
        longJobRef.current = true;
        setLongJob(true);
        lastSpeechAt.current = now;
        sentStage.current = JSON.stringify(next);
        link.current.cue("long_job", next);
        return;
      }
      const lines = narrator.take(now, { running: live.current.running, quietMs: now - lastSpeechAt.current });
      if (!lines.length) return;
      lastSpeechAt.current = now;
      sentStage.current = JSON.stringify(stageRef.current);
      link.current.say(lines, stageRef.current);
    }, 400);
    return () => clearInterval(timer);
  }, [grant.sessionId, hangUp, narrator, status, voiceNotes]);

  // The call's time: a heads-up a minute before the end, then it wraps up.
  useEffect(() => {
    if (status !== "connected") return;
    const started = Date.now() - elapsed * 1000;
    const timer = setInterval(() => setElapsed((Date.now() - started) / 1000), 1000);
    return () => clearInterval(timer);
    // Counts from when the call connects; `elapsed` is read only to carry on after a reconnect.
  }, [status]);
  // Each cue goes once: the clock ticks every second, and a cue sent again talks over itself.
  const closingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (status !== "connected" || ended.current) return;
    const cue = narrator.clock(elapsed, grant.maxSeconds);
    if (!cue) return;
    sentStage.current = JSON.stringify(stageRef.current);
    link.current?.cue(cue, stageRef.current);
    if (cue === "time_up") closingTimer.current = setTimeout(() => hangUp(), 7000);
  }, [elapsed, grant.maxSeconds, hangUp, narrator, status]);
  useEffect(() => () => void (closingTimer.current && clearTimeout(closingTimer.current)), []);

  // Switching away mutes the call right away; coming back leaves it muted until they unmute.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      // Showing something in another tab or window is the point of sharing: the call stays live.
      if (shareRef.current.kind) return;
      // They may not have heard what was said while away: a hold stops, and a read-back is said again.
      step({ type: "cancel", reason: "hidden", at: Date.now() });
      step({ type: "speaker", on: false, at: Date.now() });
      link.current?.setMuted({ mic: true, speaker: true });
      setMic(false);
      setSpeaker(false);
      setAway(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [step]);

  const unmute = () => {
    step({ type: "speaker", on: true, at: Date.now() });
    link.current?.setMuted({ mic: false, speaker: false });
    setMic(true);
    setSpeaker(true);
    setAway(false);
  };

  function submitTyped() {
    const text = typed.trim();
    if (!text) return;
    setTyped("");
    link.current?.type(text);
  }

  /** MOCK VOICE: what's in the box, said rather than typed, as the speech-to-text would hear it. */
  function submitSpoken() {
    const text = typed.trim();
    if (!text || !link.current?.mockSpeech) return;
    setTyped("");
    link.current.mockSpeech(text);
  }

  // Whose move it is, as everywhere else (src/lib/chat/move.ts); who has the floor is the call's own.
  const move = moveOf(messages.at(-1), { running });
  const orb: OrbState = closing
    ? "out_on_it"
    : !joined
      ? "ready"
      : problem
        ? "stuck"
        : status === "connecting"
          ? "connecting"
          : status === "ended"
            ? "ended"
            : mode === "speaking" && speaker
              ? "speaking"
              : move.move === "stuck"
                ? "stuck"
                : move.move === "your_call"
                  ? "your_call"
                  : move.move === "working" && progressSeen
                    ? "working"
                    : move.move === "working" || onIt
                      ? "on_it"
                      : "listening";

  const voiceLine = captions.findLast((c) => c.who === "voice");
  const memberLine = captions.findLast((c) => c.who === "you");
  const left = grant.maxSeconds - elapsed;
  const control =
    "inline-flex size-10 items-center justify-center rounded-full border border-line text-fg-2 transition-[background-color,color,transform] duration-150 hover:bg-hover hover:text-fg active:scale-[0.96]";

  return (
    <div role="dialog" aria-modal="true" aria-label={`Call with ${grant.persona.name}`} className="fixed inset-0 z-50 flex flex-col bg-bg animate-fade-in">
      {!joined ? null : grant.join.kind === "elevenlabs" ? (
        <ElevenLabsLink grant={grant} events={events} tools={toolsRef.current} onReady={(l) => (link.current = l)} />
      ) : (
        <MockVoiceLink grant={grant} events={events} tools={toolsRef.current} onReady={(l) => (link.current = l)} />
      )}

      <header className="flex h-14 shrink-0 items-center gap-2 px-4 md:px-6">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-fg">{grant.persona.name}</p>
          <p className="truncate text-[12px] text-fg-3">
            {journey?.kind === "setup" ? `Setting up ${agentName}` : agentName}
            {status === "connected" ? ` · ${clock(elapsed)}${left <= 120 ? ` · ${clock(left)} left` : ""}` : ""}
          </p>
        </div>
        {!grant.live ? (
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line px-2.5 text-[12px] text-fg-2" title="No audio: type what you'd say, and the voice's words show as captions.">
            <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
            {grant.label}
          </span>
        ) : null}
      </header>

      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[minmax(260px,2fr)_minmax(0,3fr)] md:grid-rows-1">
        {/* The orb, what's being said, and the text twin. */}
        <section aria-label="Call" className="flex flex-col items-center gap-4 border-line px-5 pt-2 pb-4 md:justify-center md:border-r md:px-8 md:pb-10">
          <div className="max-md:hidden">
            <Orb state={orb} />
          </div>
          <div className="md:hidden">
            <Orb state={orb} size={84} />
          </div>
          <p aria-live="polite" className="text-[12.5px] font-medium tracking-[0.01em] text-fg-3">
            {ORB_LABEL[orb]}
          </p>
          <div aria-live="polite" className="flex min-h-[4.5rem] w-full max-w-sm flex-col items-center gap-1.5 text-center">
            {voiceLine ? (
              <p key={voiceLine.id} className="text-[15px] leading-[1.55] text-fg animate-fade-in [overflow-wrap:anywhere] max-md:line-clamp-3">
                {voiceLine.text}
              </p>
            ) : null}
            {memberLine ? (
              <p key={memberLine.id} className="text-[13px] leading-[1.5] text-fg-3 animate-fade-in [overflow-wrap:anywhere]">
                You: {memberLine.text}
              </p>
            ) : null}
            {held.length ? (
              <p className="text-[12px] text-fg-3">
                Holding {held.length === 1 ? "what you said" : `${held.length} things you said`} until this lands
              </p>
            ) : null}
          </div>

          {closing ? (
            <div className="flex flex-col items-center gap-3 animate-fade-in">
              <p className="max-w-sm text-center text-[13.5px] text-fg-2">It&apos;s still working. You&apos;ll find it in the chat.</p>
              <button type="button" onClick={finish} className="inline-flex h-9 items-center rounded-full px-4 text-[13.5px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg">
                Back to the chat
              </button>
            </div>
          ) : problem ? (
            <div role="alert" className="w-full max-w-sm rounded-xl bg-danger-soft px-3.5 py-2.5 text-center text-[13.5px] text-fg">
              {problem} Everything&apos;s in the chat.
            </div>
          ) : away ? (
            <button type="button" onClick={unmute} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] font-medium text-fg-2 hover:bg-hover hover:text-fg">
              <Mic size={14} />
              Muted while you were away · Unmute
            </button>
          ) : null}

          {closing ? null : !joined ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setJoined(true)}
                className="inline-flex h-10 items-center gap-1.5 rounded-full bg-inverse px-5 text-[13.5px] font-medium text-on-inverse transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.97]"
              >
                <AudioLines size={16} />
                Start call
              </button>
              <button type="button" onClick={() => hangUp(false)} className="inline-flex h-10 items-center rounded-full px-4 text-[13.5px] font-medium text-fg-3 transition-colors hover:bg-hover hover:text-fg">
                Not now
              </button>
            </div>
          ) : (
            <>
              <form
                className="flex w-full max-w-sm items-center gap-1.5 rounded-xl border border-line bg-surface p-1 pl-3 focus-within:border-line-strong"
                onSubmit={(e) => {
                  e.preventDefault();
                  submitTyped();
                }}
              >
                <label htmlFor="call-type" className="sr-only">
                  {grant.capabilities.audio ? "Type instead" : "Say something"}
                </label>
                <input
                  id="call-type"
                  value={typed}
                  disabled={status !== "connected"}
                  onChange={(e) => {
                    // Typing stops a hold before a spoken approval goes.
                    step({ type: "cancel", reason: "typing", at: Date.now() });
                    // Typing on a real call stops the voice talking right away; the captions carry on.
                    if (grant.capabilities.audio && speaker && !typed) {
                      step({ type: "speaker", on: false, at: Date.now() });
                      link.current?.setMuted({ speaker: true });
                      setSpeaker(false);
                    }
                    setTyped(e.target.value);
                  }}
                  placeholder={grant.capabilities.audio ? "Type instead…" : "Type what you'd say…"}
                  className="min-w-0 flex-1 bg-transparent text-[14px] text-fg placeholder:text-fg-4 focus:outline-none"
                />
                {grant.join.kind === "mock" ? (
                  // MOCK VOICE: stands in for saying it, so QA can approve a request by voice. Send types it.
                  <button
                    type="button"
                    onClick={submitSpoken}
                    disabled={!typed.trim() || status !== "connected"}
                    title="Mock voice: take these words as spoken, the way the speech-to-text would hear them."
                    className="inline-flex h-8 shrink-0 items-center rounded-lg border border-line px-2.5 text-[12.5px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg disabled:text-fg-4"
                  >
                    Say it (mock)
                  </button>
                ) : null}
                <button type="submit" aria-label="Send" disabled={!typed.trim()} className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-inverse text-on-inverse transition-opacity hover:opacity-90 disabled:bg-press disabled:text-fg-4">
                  <ArrowUp size={15} />
                </button>
              </form>

              <SharePanel share={share} snapping={snapping} snapped={snapped} onSnap={() => void snapNow()} disabled={status !== "connected"} />

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label={mic ? "Mute your mic" : "Unmute your mic"}
                  aria-pressed={!mic}
                  onClick={() => {
                    link.current?.setMuted({ mic: mic });
                    setMic(!mic);
                    setAway(false);
                  }}
                  className={control}
                >
                  {mic ? <Mic size={17} /> : <MicOff size={17} />}
                </button>
                <button
                  type="button"
                  aria-label={speaker ? "Mute the voice" : "Unmute the voice"}
                  aria-pressed={!speaker}
                  onClick={() => {
                    step({ type: "speaker", on: !speaker, at: Date.now() });
                    link.current?.setMuted({ speaker: speaker });
                    setSpeaker(!speaker);
                    setAway(false);
                  }}
                  className={control}
                >
                  {speaker ? <Volume2 size={17} /> : <VolumeX size={17} />}
                </button>
                <button
                  type="button"
                  onClick={() => hangUp()}
                  className="inline-flex h-10 items-center gap-1.5 rounded-full bg-danger px-4 text-[13.5px] font-medium text-on-inverse transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.97]"
                >
                  <PhoneOff size={16} />
                  {problem ? "Back to the chat" : "End call"}
                </button>
              </div>
            </>
          )}
        </section>

        {/* The stage: only what the backend reported. */}
        <section aria-label="On screen" className="scroll-quiet min-h-0 overflow-y-auto border-t border-line px-4 pt-4 pb-10 md:border-t-0 md:px-8 md:pt-6">
          <div className="mx-auto flex w-full max-w-[40rem] flex-col">
            {journey ? (
              <Journey
                steps={journey.steps}
                goal={journey.goal}
                {...(journey.kind === "setup" ? { title: SETUP_JOURNEY_TITLE, growing: true } : {})}
                move={move.move}
              />
            ) : null}
            {grant.browserView ? <BrowserView key={conversationId} conversationId={conversationId} active={browsing || messages.some((m) => m.activity?.some((a) => a.app === "browser"))} /> : null}
            {latestReply?.content.trim() ? (
              <div className="mt-4 text-[14.5px]">
                <Markdown content={latestReply.content} citations={latestReply.citations} />
              </div>
            ) : running ? (
              <p className="mt-6 text-center text-[13px] text-fg-3">The agent&apos;s cards show up here.</p>
            ) : null}
            {latestReply?.status === "awaiting"
              ? (latestReply.approvals ?? [])
                  .filter((a) => a.status === "pending")
                  .map((approval) => (
                    <ApprovalCard
                      key={approval.id}
                      approval={approval}
                      conversationId={conversationId}
                      onDecide={(decision) => {
                        // A tap answers it outright, and stops any hold on it.
                        step({ type: "cancel", reason: "tap", at: Date.now() });
                        onDecide(approval.id, decision);
                      }}
                      call={{
                        spoken: spokenOn,
                        spent: spent.includes(approval.id),
                        hold:
                          approving?.id === approval.id
                            ? {
                                left: Math.max(0, Math.min(1, (approving.until - holdNow) / HOLD_MS)),
                                // Run out, and waiting for them to go quiet before it goes.
                                waiting: holdNow >= approving.until,
                                onCancel: () => step({ type: "cancel", reason: "tap", at: Date.now() }),
                              }
                            : null,
                      }}
                    />
                  ))
              : null}
            {ask.reply && ask.questions ? (
              <QuestionCard questions={ask.questions} draftKey={questionsKey} onAnswer={(text) => send(withHeld(text), { steer: false })} />
            ) : null}
            {/* A failed reply is tried again with a tap here, or by saying "try again". */}
            {onRetry && !running && (latestReply?.status === "error" || latestReply?.status === "interrupted") && latestReply === messages.at(-1) ? (
              <div className="mt-4 flex items-center gap-2 rounded-xl bg-danger-soft py-2 pr-2 pl-3.5 animate-fade-up">
                <p className="min-w-0 flex-1 text-[13.5px] text-fg">
                  {latestReply.status === "error" ? (latestReply.error ?? "Something went wrong.") : "That got cut off before it finished."}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setOnIt(true);
                    setProgressSeen(false);
                    onRetry(latestReply.id);
                  }}
                  className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg"
                >
                  <RotateCcw size={13} />
                  Retry
                </button>
              </div>
            ) : null}
            {/* An offer to call means nothing on one. */}
            {latestReply?.ui?.some((b) => b.kind !== "offer") ? (
              <UiCards
                blocks={latestReply.ui.filter((b) => b.kind !== "offer")}
                responses={latestReply.uiResponse}
                conversationId={conversationId}
                messageId={latestReply.id}
                onAnswer={ask.reply ? (text, extras) => send(withHeld(text), { steer: false, attachments: extras.attachments }) : undefined}
                onResponse={onUiResponse}
                onRunTask={onRunTask}
                settled={latestReply.status === "complete"}
              />
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

/** The live picture of what they're sharing, small, so they can see what the agent would see. */
function SharePreview({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay muted playsInline aria-hidden="true" className="h-12 w-20 shrink-0 rounded-md bg-press object-cover" />;
}

/**
 * Showing the call your screen or camera: a tap starts it (the browser asks which screen), and
 * it stays on the device until they say "look at this" or tap Snap, which sends one frame with
 * their words. The plain line says what a snapshot can catch.
 */
function SharePanel({
  share,
  snapping,
  snapped,
  onSnap,
  disabled,
}: {
  share: ReturnType<typeof useShare>;
  snapping: boolean;
  snapped: number;
  onSnap: () => void;
  disabled: boolean;
}) {
  const quiet =
    "inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg disabled:opacity-40";
  if (!share.kind) {
    if (!share.canScreen && !share.canCamera) return null;
    return (
      <div className="flex w-full max-w-sm flex-col items-center gap-1.5">
        <div className="flex items-center gap-2">
          {share.canScreen ? (
            <button type="button" disabled={disabled} onClick={() => void share.start("screen")} className={quiet}>
              <MonitorUp size={14} />
              Show my screen
            </button>
          ) : null}
          {share.canCamera ? (
            <button type="button" disabled={disabled} onClick={() => void share.start("camera")} className={quiet}>
              <Camera size={14} />
              Show camera
            </button>
          ) : null}
        </div>
        {share.problem ? (
          <p role="status" className="text-center text-[12px] text-fg-3">
            {share.problem}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex w-full max-w-sm flex-col gap-1.5 rounded-xl border border-line p-2.5">
      <div className="flex items-center gap-2.5">
        {share.stream ? <SharePreview stream={share.stream} /> : null}
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-fg">Sharing your {share.kind}</p>
          <p className="text-[12px] text-fg-3">Say “look at this”, or tap Snap.</p>
        </div>
        <button type="button" disabled={disabled || snapping} onClick={onSnap} className={quiet}>
          Snap
        </button>
        <button type="button" onClick={share.stop} className="inline-flex h-8 items-center rounded-lg px-2.5 text-[13px] font-medium text-fg-3 transition-colors hover:bg-hover hover:text-fg">
          Stop
        </button>
      </div>
      <p aria-live="polite" className="text-[12px] leading-[1.45] text-fg-3">
        {snapping
          ? "Taking a snapshot…"
          : share.problem
            ? share.problem
            : snapped
              ? `${snapped === 1 ? "A snapshot is" : `${snapped} snapshots are`} ready: ${snapped === 1 ? "it goes" : "they go"} with what you say next.`
              : "Nothing is sent until you ask. A snapshot shows whatever's in view, including other people, and is saved with your message."}
      </p>
    </div>
  );
}

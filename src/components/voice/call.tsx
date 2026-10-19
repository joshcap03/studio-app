"use client";

import { ArrowUp, AudioLines, Mic, MicOff, PhoneOff, Volume2, VolumeX } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCardDrafts, type FillResult } from "@/components/chat/card-drafts";
import { Markdown } from "@/components/chat/markdown";
import { ApprovalCard, QuestionCard } from "@/components/chat/requests";
import { UiCards } from "@/components/chat/ui-cards";
import { Journey } from "@/components/ui/journey";
import type { FormValues } from "@/lib/chat/ui-answer";
import { api } from "@/lib/client/api";
import { isBackchannel, isRedirect, isSendIntent, isStopIntent } from "@/lib/voice/intent";
import { initialRelay, relayEvent, relayJourney, relayReply, type RelayLine } from "@/lib/voice/relay";
import type { StageField, VoiceGrant, VoiceStage } from "@/lib/voice/types";
import type { Attachment, ChatMessage, JourneyStep, StreamEvent, UiField, UiForm, UiResponse } from "@/lib/types";
import type { LinkStatus, VoiceLink, VoiceLinkEvents, VoiceTools } from "./link";
import MockVoiceLink from "./mock-link";
import { Orb, ORB_LABEL, type OrbState } from "./orb";

// A call with the agent: the orb (who has the floor, and whose move it is) beside the stage,
// which shows only what the backend reported: the journey rail, the latest reply, and the
// agent's own cards, answerable by tap or by voice. The voice is the agent's mouth and ears;
// the member's words go to the worker verbatim, its real progress is read out (relay.ts), and
// nothing is sent until they say "send" or tap. Talking over a running job is held for when it
// lands; only a clear "stop" or "actually…" redirects it, since that stops the work and declines
// any request waiting on them.

const ElevenLabsLink = dynamic(() => import("./elevenlabs-link"), { ssr: false });

export interface CallProps {
  grant: VoiceGrant;
  /** The agent's name, for the header ("Setting up Job search"). */
  agentName: string;
  conversationId: string;
  messages: ChatMessage[];
  running: boolean;
  /** The setup journey, when this call is the setup interview. */
  plan: JourneyStep[] | null;
  /** Sends the member's words (or a card's answer) as their next message, on the call. */
  onSend: (text: string, options: { steer: boolean; attachments?: Attachment[] }) => void;
  onStop: () => void;
  onDecide: (approvalId: string, decision: "approve" | "reject") => void;
  onUiResponse: (messageId: string, blockId: string, response: UiResponse) => void;
  onRunTask?: (taskId: string) => Promise<void>;
  /** Streamed events of runs in this workspace, for narrating real progress. */
  subscribe: (listener: (conversationId: string, event: StreamEvent) => void) => () => void;
  /** The call is over; the chat takes it from here. */
  onEnd: () => void;
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

const PROGRESS_GAP_MS = 6000;
const AFTER_SPEECH_MS = 900;

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

/** A call failure in plain words; the browser's own wording for a refused mic is just "Permission denied". */
export function callProblem(message: string | undefined): string {
  const text = (message ?? "").trim();
  if (/permission|not ?allowed|denied/i.test(text)) {
    return "Studio couldn't use your microphone. Allow it for this site (the icon at the left of the address bar), then start the call again.";
  }
  if (/not ?found|no (microphone|audio|device)|requested device/i.test(text)) return "No microphone found. Connect one and start the call again.";
  return text ? `${text.replace(/[.!]?$/, ".")}` : "The call dropped.";
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function Call({ grant, agentName, conversationId, messages, running, plan, onSend, onStop, onDecide, onUiResponse, onRunTask, subscribe, onEnd, waitForTap = false }: CallProps) {
  const drafts = useCardDrafts();
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
  const captionId = useRef(0);

  // What the member said on this call, verbatim, and how much of it has been acted on.
  const spoken = useRef<string[]>([]);
  const consumed = useRef(0);
  /** Where the words about the card now on screen begin. */
  const cardSince = useRef(0);
  const heldRef = useRef<string[]>([]);
  heldRef.current = held;

  // Lines waiting to be said: the latest progress (newer replaces older), and the rest in order.
  const pendingLines = useRef<string[]>([]);
  const pendingProgress = useRef<string | null>(null);
  const lastProgressAt = useRef(0);
  const lastSpeechAt = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const relayState = useRef(initialRelay());
  const ended = useRef(false);
  /** A redirect stopped the run before this one; its "Stopped" isn't news. */
  const steered = useRef(false);

  const live = useRef({ messages, running, conversationId });
  live.current = { messages, running, conversationId };

  const ask = openAsk(messages, running);
  const questionsKey = ask.reply ? `${ask.reply.id}:questions` : "";
  const latestReply = messages.findLast((m) => m.role === "assistant");

  const stage = useMemo<VoiceStage>(() => {
    const draft = ask.form ? drafts.form(ask.form) : null;
    const pendingApproval = latestReply?.status === "awaiting" ? latestReply.approvals?.find((a) => a.status === "pending") : undefined;
    const proposal = ask.reply?.ui?.find((b) => b.kind === "proposal" && !ask.reply!.uiResponse?.[b.id]);
    const at = plan ? plan.findIndex((s) => s.status === "doing" || s.status === "needs_you") : -1;
    const current = plan ? (plan[at >= 0 ? at : plan.findIndex((s) => s.status !== "done")]?.text ?? null) : null;
    return {
      working: running,
      ...(plan?.length ? { journey: { done: plan.filter((s) => s.status === "done").length, total: plan.length, current } } : {}),
      ...(ask.form && draft && !draft.sent ? { form: { id: ask.form.id, title: ask.form.title, fields: ask.form.fields.map((f) => stageField(f, draft.values[f.id])) } } : {}),
      ...(ask.questions && !drafts.question(questionsKey, ask.questions).sent
        ? { questions: ask.questions.map((q) => ({ question: q.question, options: q.options.map((o) => o.label), multi: q.multiSelect })) }
        : {}),
      ...(proposal && proposal.kind === "proposal" ? { proposal: proposal.summary } : {}),
      ...(pendingApproval ? { approval: pendingApproval.summary } : {}),
    };
  }, [ask.form, ask.questions, ask.reply, drafts, latestReply, plan, questionsKey, running]);
  const stageRef = useRef(stage);
  stageRef.current = stage;

  const caption = useCallback((who: Caption["who"], text: string) => {
    captionId.current += 1;
    const id = captionId.current;
    setCaptions((list) => [...list.slice(-5), { id, who, text }]);
  }, []);

  const queue = useCallback((lines: RelayLine[]) => {
    for (const line of lines) {
      if (line.droppable) pendingProgress.current = line.text;
      else pendingLines.current.push(line.text);
    }
  }, []);
  /** Each reply is read out once, whether it ended during the call or before it was joined. */
  const readReplies = useRef(new Set<string>());
  const queueReply = useCallback(
    (message: ChatMessage) => {
      // By status too: a reply paused for an approval is read again when it finishes.
      const key = `${message.id}:${message.status}`;
      if (readReplies.current.has(key)) return;
      readReplies.current.add(key);
      queue(relayReply(message));
    },
    [queue],
  );

  // ---------------------------------------------------------------------------------------
  // Ending

  const hangUp = useCallback(
    (sound = true) => {
      if (ended.current) return;
      ended.current = true;
      link.current?.end();
      if (sound) tone(false);
      api.endVoice(grant.sessionId).catch(() => undefined);
      onEnd();
    },
    [grant.sessionId, onEnd],
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
  const cardWords = () => spoken.current.slice(cardSince.current).join(" ");

  /** The member's next message, with anything they said while the agent was busy. */
  const withHeld = useCallback((text: string) => {
    const earlier = heldRef.current.join(" ");
    if (!earlier) return text;
    setHeld([]);
    heldRef.current = [];
    return `${text}\n\nAlso, while you were working: ${earlier}`;
  }, []);

  const send = useCallback(
    (text: string, options: { steer: boolean; attachments?: Attachment[] }) => {
      setOnIt(true);
      setProgressSeen(false);
      steered.current = options.steer && live.current.running;
      onSend(text, options);
    },
    [onSend],
  );

  const handOff = useCallback((): string => {
    const words = pending().join(" ").trim();
    if (!words) return "Refused: they haven't said anything new to pass on.";
    consume();
    const { running: busy, messages: now } = live.current;
    const awaiting = now.at(-1)?.status === "awaiting";
    if (busy || awaiting) {
      if (isRedirect(words)) {
        send(words, { steer: true });
        return awaiting
          ? "Handed off: their change of course. The request that was waiting on their OK was declined."
          : "Handed off: their change of course. The earlier work stopped.";
      }
      setHeld((list) => [...list, words]);
      return awaiting ? "Held: it's waiting on their OK on screen; their words go along after." : "Held: until the current work lands.";
    }
    send(withHeld(words), { steer: false });
    return "Handed off: sent to the worker.";
  }, [send, withHeld]);

  const tools: VoiceTools = {
    send_message: () => handOff(),
    stop_work: () => {
      const said = lastWords();
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
        link.current?.cue("hello", stageRef.current);
      } else if (next === "ended") {
        hangUp();
      } else if (next === "error") {
        setProblem(callProblem(message));
        api.endVoice(grant.sessionId).catch(() => undefined);
      }
    },
    onMode: (next) => {
      setMode(next);
      lastSpeechAt.current = Date.now();
    },
    onMemberText: (text) => {
      spoken.current.push(text);
      caption("you", text);
    },
    onVoiceText: (text) => caption("voice", text),
    onInterrupted: () => {
      lastSpeechAt.current = Date.now();
    },
  };

  // Real progress from the worker, as it reports it.
  useEffect(
    () =>
      subscribe((id, event) => {
        if (id !== live.current.conversationId || ended.current) return;
        const out = relayEvent(relayState.current, event);
        relayState.current = out.state;
        queue(out.lines);
        if (event.type === "activity" && !event.step.hidden) setProgressSeen(true);
        if (event.type === "end") {
          if (steered.current && event.message.status === "stopped") {
            steered.current = false;
            return;
          }
          pendingProgress.current = null;
          queueReply(event.message);
          setOnIt(false);
          cardSince.current = spoken.current.length;
          // Words held while it worked go along with their next message when it asks for one,
          // and on their own otherwise.
          const asksNow = Boolean(event.message.questions?.length || event.message.ui?.some((b) => b.kind === "form"));
          if (heldRef.current.length && !asksNow && event.message.status !== "awaiting") {
            const words = heldRef.current.join(" ");
            setHeld([]);
            heldRef.current = [];
            pendingLines.current.push("Now passing along what you said.");
            setTimeout(() => !ended.current && send(words, { steer: false }), 400);
          }
        }
      }),
    [queue, queueReply, send, subscribe],
  );

  // Picking up where it left off: once connected and the conversation is loaded, what's waiting
  // on them now. A call that starts a new turn hears about it as the turn goes.
  const caughtUp = useRef(false);
  useEffect(() => {
    if (caughtUp.current || status !== "connected" || (!messages.length && !running)) return;
    caughtUp.current = true;
    const { reply } = openAsk(messages, running);
    if (reply) queueReply(reply);
  }, [messages, queueReply, running, status]);

  // What finishing each journey step gave the agent.
  const lastPlan = useRef(plan);
  useEffect(() => {
    if (plan && lastPlan.current) queue(relayJourney(lastPlan.current, plan));
    lastPlan.current = plan;
  }, [plan, queue]);

  // The voice's view of the stage, kept current.
  const stageJson = JSON.stringify(stage);
  useEffect(() => {
    if (status === "connected") link.current?.stage(JSON.parse(stageJson) as VoiceStage);
  }, [stageJson, status]);

  // Saying queued lines: never over the voice itself, and progress at a calm pace.
  useEffect(() => {
    const timer = setInterval(() => {
      if (status !== "connected" || ended.current || !link.current) return;
      const now = Date.now();
      if (modeRef.current === "speaking" || now - lastSpeechAt.current < AFTER_SPEECH_MS) return;
      const lines = pendingLines.current.splice(0);
      const progress = pendingProgress.current;
      if (progress && (lines.length || now - lastProgressAt.current >= PROGRESS_GAP_MS)) {
        lines.push(progress);
        pendingProgress.current = null;
        lastProgressAt.current = now;
      }
      if (!lines.length) return;
      lastSpeechAt.current = now;
      link.current.say(lines, stageRef.current);
    }, 400);
    return () => clearInterval(timer);
  }, [status]);

  // The call's time: a heads-up a minute before the end, then it wraps up.
  useEffect(() => {
    if (status !== "connected") return;
    const started = Date.now() - elapsed * 1000;
    const timer = setInterval(() => setElapsed((Date.now() - started) / 1000), 1000);
    return () => clearInterval(timer);
    // Counts from when the call connects; `elapsed` is read only to carry on after a reconnect.
  }, [status]);
  const warned = useRef(false);
  useEffect(() => {
    if (status !== "connected" || ended.current) return;
    if (!warned.current && grant.maxSeconds > 120 && elapsed >= grant.maxSeconds - 60) {
      warned.current = true;
      link.current?.cue("heads_up", stageRef.current);
    }
    if (elapsed >= grant.maxSeconds) {
      link.current?.cue("time_up", stageRef.current);
      const timer = setTimeout(() => hangUp(), 7000);
      return () => clearTimeout(timer);
    }
  }, [elapsed, grant.maxSeconds, hangUp, status]);

  // Switching away mutes the call right away; coming back leaves it muted until they unmute.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      link.current?.setMuted({ mic: true, speaker: true });
      setMic(false);
      setSpeaker(false);
      setAway(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const unmute = () => {
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

  const lastAssistant = latestReply;
  const orb: OrbState = !joined
    ? "ready"
    : problem
    ? "stuck"
    : status === "connecting"
      ? "connecting"
      : status === "ended"
        ? "ended"
        : mode === "speaking" && speaker
          ? "speaking"
          : lastAssistant && !running && (lastAssistant.status === "error" || lastAssistant.status === "interrupted")
            ? "stuck"
            : lastAssistant?.status === "awaiting" || stage.form || stage.questions || stage.proposal
              ? "your_call"
              : running && progressSeen
                ? "working"
                : running || onIt
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
            {plan ? `Setting up ${agentName}` : agentName}
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

          {problem ? (
            <div role="alert" className="w-full max-w-sm rounded-xl bg-danger-soft px-3.5 py-2.5 text-center text-[13.5px] text-fg">
              {problem} Everything&apos;s in the chat.
            </div>
          ) : away ? (
            <button type="button" onClick={unmute} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] font-medium text-fg-2 hover:bg-hover hover:text-fg">
              <Mic size={14} />
              Muted while you were away · Unmute
            </button>
          ) : null}

          {!joined ? (
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
                    // Typing on a real call stops the voice talking right away; the captions carry on.
                    if (grant.capabilities.audio && speaker && !typed) {
                      link.current?.setMuted({ speaker: true });
                      setSpeaker(false);
                    }
                    setTyped(e.target.value);
                  }}
                  placeholder={grant.capabilities.audio ? "Type instead…" : "Type what you'd say…"}
                  className="min-w-0 flex-1 bg-transparent text-[14px] text-fg placeholder:text-fg-4 focus:outline-none"
                />
                <button type="submit" aria-label="Send" disabled={!typed.trim()} className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-inverse text-on-inverse transition-opacity hover:opacity-90 disabled:bg-press disabled:text-fg-4">
                  <ArrowUp size={15} />
                </button>
              </form>

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
            {plan?.length ? <Journey steps={plan} title="Setting up" growing /> : null}
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
                  .map((approval) => <ApprovalCard key={approval.id} approval={approval} onDecide={(decision) => onDecide(approval.id, decision)} />)
              : null}
            {ask.reply && ask.questions ? (
              <QuestionCard questions={ask.questions} draftKey={questionsKey} onAnswer={(text) => send(withHeld(text), { steer: false })} />
            ) : null}
            {latestReply?.ui?.length ? (
              <UiCards
                blocks={latestReply.ui}
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

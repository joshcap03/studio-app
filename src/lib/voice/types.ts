// The contract between Studio and a voice provider (ElevenLabs today, a labeled mock for QA).
// The voice front is the agent's mouth and ears on a call; the worker (src/lib/agent) does all
// the thinking and work. Shared by the browser and the server, so no runtime imports here.

import type { Journey } from "@/lib/types";
import type { VoiceKey } from "./voices";

export type VoiceProviderId = "mock" | "elevenlabs";

/** What the app shows about voice for one member; absent when calls are off for them. */
export interface VoiceStatus {
  provider: VoiceProviderId;
  label: string;
  /** False for the mock: its calls take typed speech, and its speech is a tone. */
  live: boolean;
  /** What works outside a call (src/lib/voice/speech.ts). */
  speech: SpeechCapabilities;
}

/**
 * Speech outside a call: an agent's voice saying a line (previews, voice notes) and a member's
 * recording turned into text. Under the mock (live false) speech is a short tone and the member
 * types what they'd say.
 */
export interface SpeechCapabilities {
  tts: boolean;
  stt: boolean;
}

/** What a voice provider has been verified to do. The call adapts to these. */
export interface VoiceCapabilities {
  /** Real audio both ways. The mock shows captions and takes typed "speech" instead. */
  audio: boolean;
  /** The provider stops its own speech when the member talks over it. */
  bargeIn: boolean;
  /** The member's words arrive as final speech-to-text transcripts, handed off verbatim. */
  verbatimTranscripts: boolean;
}

/** How the browser joins a call the server opened. */
export type VoiceJoin = { kind: "mock" } | { kind: "elevenlabs"; conversationToken: string };

/**
 * A call's persona: the name it goes by with this member and the voice they chose (or its
 * template's), as the server picked them (src/lib/voice/persona.ts).
 */
export interface VoicePersona {
  name: string;
  /** Studio's key for the voice (src/lib/voice/voices.ts). */
  voice: VoiceKey;
  /** The provider's voice id, applied when the browser joins; null keeps the provider agent's own voice. */
  voiceId: string | null;
}

/** What the browser gets when a call starts. The only provider credential in it is a short-lived join token. */
export interface VoiceGrant {
  /** Studio's voice_sessions row. */
  sessionId: string;
  provider: VoiceProviderId;
  /** Shown on the call ("Mock voice" for the mock). */
  label: string;
  live: boolean;
  capabilities: VoiceCapabilities;
  /** The provider's id for this call, which the sealed context is bound to. */
  conversationId: string;
  join: VoiceJoin;
  /** The sealed voice context (src/lib/voice/seal.ts). Opaque to the browser; passed back as a header. */
  context: string;
  persona: VoicePersona;
  /** How long this call may run. */
  maxSeconds: number;
}

/**
 * Sealed when a call starts, under the member's session, and checked on every request the
 * provider makes to the voice front, which has no session of its own. Bound to one call.
 */
export interface VoiceContext {
  v: 1;
  /** voice_sessions id */
  sid: string;
  /** The provider's conversation id; must match the provider's own header. */
  cid: string;
  provider: VoiceProviderId;
  uid: string;
  ws: string;
  /** Expiry, ms since epoch. */
  exp: number;
  name: string;
  /** What the member goes by (their first name, from their account), for the greeting. */
  member?: string | null;
  /** What the agent is, e.g. "Job search", for the voice's own bearings. */
  agent: string;
  /** The member's personal guardrail, which comes first and overrides everything else. */
  guardrail: string | null;
  /** How the agent talks with this member, in its own words, once one is chosen (tone only). */
  manner?: string | null;
}

/** One field of the card on stage, as the voice sees it. */
export interface StageField {
  id: string;
  label: string;
  kind: string;
  required: boolean;
  /** Option labels for choice, multi-choice, and rank fields. */
  options?: string[];
  /** Verdict items, numbered from 1 as the member hears them. */
  items?: { n: number; id: string; title: string }[];
  scale?: { steps: number; low: string; high: string };
  /** Why the member might pass, for verdict fields. */
  reasons?: string[];
  /** What's filled in so far, in a few words. */
  current?: string;
  /** Files, apps to connect: answered with a tap, never by voice. */
  tapOnly?: boolean;
}

/** What a call is about: the setup interview, one of the member's tasks as it runs, or any other chat. */
export const CALL_PURPOSES = ["setup", "task", "chat"] as const;
export type CallPurpose = (typeof CALL_PURPOSES)[number];

/**
 * What's on the call's stage, compactly, for the voice to answer against: the latest card the
 * worker reported and the journey. Built in the browser from what the backend reported; the
 * voice front treats it as data, never as instructions.
 */
export interface VoiceStage {
  /** The worker is running a turn right now. */
  working: boolean;
  /** What the call is about; absent from pages loaded before calls could be had anywhere (those were setup calls). */
  purpose?: CallPurpose;
  /**
   * The plan of the work on screen: how far along, the step under way, what done looks like
   * (`goal`, in the agent's words), and whose plan it is (`kind`). Pages loaded before plans had
   * kinds send none, and only ever sent the setup interview's, so a journey without one is setup.
   */
  journey?: { done: number; total: number; current: string | null; goal?: string | null; kind?: Journey["kind"] };
  form?: { id: string; title: string; fields: StageField[] };
  questions?: { question: string; options: string[]; multi: boolean }[];
  proposal?: string;
  approval?: string;
  /**
   * The call asked whether they'd rather hang on or get a voice note when the job is done (the
   * long_job cue), and they haven't said yet.
   */
  longJob?: boolean;
}

/** The title the setup interview's journey carries on screen. */
export const SETUP_JOURNEY_TITLE = "Setting up";

/**
 * Cues the browser sends the voice front; each makes it say one fixed, server-built line.
 * `long_job`: a job on the call has gone a while with nothing new.
 */
export const VOICE_CUES = ["hello", "heads_up", "time_up", "long_job"] as const;
export type VoiceCue = (typeof VOICE_CUES)[number];

/**
 * What the browser tells the voice front through the provider (as a marked user message):
 * relay lines to say (src/lib/voice/relay.ts), the stage, or a cue. Never member speech.
 */
export interface VoiceMarker {
  say?: string[];
  stage?: VoiceStage;
  cue?: VoiceCue;
}

/** The prefix that marks a VoiceMarker. Speech-to-text never produces it. */
export const VOICE_MARKER = "⟦studio⟧";

/** The client tools the voice front may call; the browser runs them, never the voice. */
export const VOICE_TOOL_NAMES = ["fill_card", "send_card", "answer_question", "send_message", "stop_work"] as const;
export type VoiceToolName = (typeof VOICE_TOOL_NAMES)[number];

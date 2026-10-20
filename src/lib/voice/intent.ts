// What the member's own words on a call ask for, read from the speech-to-text transcript (never
// from the voice front's paraphrase). Deliberately strict: a card is sent only on a clear
// "send", the work stops only on a clear "stop", only a clear "stop" or "actually…" redirects
// a running job (redirecting aborts it and declines any pending approval), a failed reply is
// tried again only on a clear "try again", and a call ends for a voice note only when they ask
// for one. Pure.

/** Lowercase words only: punctuation becomes spaces, apostrophes vanish ("that's" → "thats"). */
export function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const FILLERS = /\b(um+|uh+|er+|erm|hmm+|mm+)\b/g;

/** The words with spoken fillers dropped, for comparing what was said with what was written down. */
export function spokenWords(text: string): string {
  return normalizeSpeech(text).replace(FILLERS, " ").replace(/\s+/g, " ").trim();
}

/** Clauses in speaking order, split at sentence breaks and "and"/"then". */
function clauses(text: string): string[] {
  return text
    .split(/[.!?;\n]+|,\s*(?:and\s+)?then\b|\band then\b|\band\b/i)
    .map(normalizeSpeech)
    .filter(Boolean);
}

const BACKCHANNELS = new Set([
  "mm hm", "mhm", "mm", "mmm", "uh huh", "uh", "um", "hmm", "yeah", "yep", "yup", "okay", "ok", "right", "sure", "alright",
  "got it", "gotcha", "i see", "cool", "nice", "wow", "oh", "ah", "huh", "okay okay", "yeah yeah", "right right",
]);

/** Acknowledgements that keep the floor ("mm-hm", "yeah"); never something to hand off. */
export function isBackchannel(text: string): boolean {
  const words = normalizeSpeech(text);
  return words === "" || BACKCHANNELS.has(words);
}

const LEAD_IN = "(?:(?:ok|okay|yes|yeah|yep|great|perfect|good|alright|right|cool|so|now|that s it|thats it|thats all|thats good|looks good|done|please|go ahead and|you can|lets)\\s+)*";
const SEND = new RegExp(`^${LEAD_IN}(?:send|submit|hit send)(?:\\s+(?:it|that|this|them|those|these|the form|the card|my answers?))?(?:\\s+(?:now|please|over|off|in))*$`);

/** The member said to send what's on screen: "send", "okay, send it", "keep four and send". */
export function isSendIntent(text: string): boolean {
  const last = clauses(text).at(-1);
  return Boolean(last && SEND.test(last));
}

const STOP = /^(?:(?:ok|okay|no|please|hey|wait)\s+)*(?:stop|cancel|halt)(?:\s+(?:it|that|this|now|please|working|everything|the search|for now|there))*$/;

/** The member asked to stop the work, and nothing more: "stop", "okay, stop that". */
export function isStopIntent(text: string): boolean {
  const all = clauses(text);
  return all.length > 0 && all.every((c) => STOP.test(c));
}

const REDIRECT = /^(?:(?:no|oh|wait|hold on|okay|ok)\s+)*(?:actually|stop|scratch that|change of plan|instead)\b\s*\S/;

/** A clear change of course while the agent works: "actually, look in Austin", "stop, do X instead". */
export function isRedirect(text: string): boolean {
  return REDIRECT.test(normalizeSpeech(text));
}

const RETRY = /^(?:(?:ok|okay|yes|yeah|please|can you|could you|lets|just|um|uh)\s+)*(?:try (?:it |that |this )?again|retry(?: it| that)?|give it another (?:go|try)|have another go|go again)(?:\s+(?:please|now))*$/;

/** The member asked to try again what just failed, and nothing more: "try again", "okay, retry that". */
export function isRetryIntent(text: string): boolean {
  const all = clauses(text);
  return all.length > 0 && all.every((c) => RETRY.test(c));
}

/**
 * Turning the note down: "no voice note", "I don't need a voice note", "not a voice note". A bare
 * "no" counts only right before the note ("No, a voice note is fine" answers "Want to hang on?").
 */
const REFUSE_NOTE =
  "(?:no (?:need for (?:a |any )?)?|(?:i )?(?:dont|do not|not|never|without) (?:(?:need|want|send|leave|get|bother(?: with)?) )?(?:me )?(?:a |the |any )?)(?:voice ?notes?|voice message|note)";
const NO_NOTE = new RegExp(`\\b${REFUSE_NOTE}\\b`);

/** "Let me know when it's done", which goes with hanging on: on a call, that's the voice telling them. */
const TELL_ME = "(?:(?:just|and|then|please) )*(?:you )?(?:let me know|tell me) when (?:its|it is|youre|you are) (?:done|ready|finished)(?: (?:please|thanks|thank you))*";

const HANG_ON = new RegExp(
  "^(?:(?:yeah|yes|yep|ok|okay|sure|no|nah|nope|thanks|thank you|fine|its fine|thats fine|im good|im fine|i think|id rather|actually|just|" +
    REFUSE_NOTE +
    ")\\s+)*(?:ill |i will |i can |im happy to |happy to |lets )?(?:just )?(?:hang on|wait|stay(?: on)?|stick around|keep going|stay on the line)(?:\\s+(?:here|then|for it|on the line|thanks|thank you|please))*" +
    `(?: ${REFUSE_NOTE}(?: thanks| thank you| please)?)?(?: ${TELL_ME})?$`,
);
const TELL_ME_ALONE = new RegExp(`^${TELL_ME}$`);

/**
 * Their answer to "hang on, or a voice note?" is to stay on while it works, and nothing more:
 * "I'll hang on", "yeah, I can wait", "no voice note, I'll wait", "I'll wait, no need for a voice
 * note", "I'll hang on, let me know when it's done".
 */
export function isHangOnIntent(text: string): boolean {
  const all = clauses(text);
  return all.some((c) => HANG_ON.test(c)) && all.every((c) => HANG_ON.test(c) || TELL_ME_ALONE.test(c));
}

/**
 * The whole of a clause asking for the note: "voice note", "no, send me a voice note", "a voice
 * note is fine". Anchored, so a request that mentions a note ("send a note to Sarah", "leave a
 * note on the invoice") is never taken for one.
 */
const NOTE_ANSWER = new RegExp(
  "^(?:(?:no|nah|nope|not now|thanks|ok|okay|yes|yeah|yep|sure|fine|actually|just|please|i think|id rather|id prefer|id like|i want|maybe|can you|could you|you can)\\s+)*" +
    "(?:(?:(?:just )?(?:send|leave|drop|give)(?: me)? |(?:ill )?(?:have|get|take) )?(?:a |the )?(?:voice ?note|voice message)|(?:just )?(?:send|leave|drop) me (?:a )?note)" +
    "(?:\\s+(?:is fine|is good|is better|works|would be good|would be great|would be better|please|thanks|thank you|then|instead|later|when (?:its|it is|youre|you are) (?:done|ready|finished)))*$",
);

/** A question about it ("what's a voice note?"), not a request ("can you send me a voice note?"). */
const ASKS_ABOUT = /^(?:what|whats|how|why|is|does|do)\b/;

/**
 * Their answer to "hang on, or a voice note?" is the voice note, and nothing more: "voice note",
 * "just send me a voice note", "no, a voice note is fine". Anything said with it ("…and add Acme
 * to the tracker") isn't this answer, so it goes to the worker rather than ending the call.
 */
export function isVoiceNoteIntent(text: string): boolean {
  if (/\?\s*$/.test(text.trim()) && ASKS_ABOUT.test(normalizeSpeech(text))) return false;
  const all = clauses(text);
  return all.length > 0 && all.every((c) => NOTE_ANSWER.test(c) && !NO_NOTE.test(c));
}

/**
 * How long after the job came back an answer to "hang on, or a voice note?" is still taken as
 * one: the voice heard the question with the job going, and its stage catches up a moment later.
 */
export const LATE_ANSWER_MS = 5000;

/** Where the call's "hang on, or a voice note?" stands: asked and still `open`, or closed by the job coming back at `closedAt`. */
export interface LongJobQuestion {
  open: boolean;
  running: boolean;
  closedAt: number | null;
  now: number;
}

/**
 * What the member's words since they last spoke to the worker (`said`, oldest first) answer to
 * the call's "hang on, or a voice note?": the answer is what they said last, and only that;
 * anything before it is talk-over like any other (`earlier`). `late` when the job came back just
 * before it, so there's nothing to wait for. Null when they didn't answer it.
 */
export function longJobAnswer(said: string[], question: LongJobQuestion): { answer: "note" | "wait"; late: boolean; earlier: string } | null {
  const last = said.at(-1) ?? "";
  const answer = isVoiceNoteIntent(last) ? "note" : isHangOnIntent(last) ? "wait" : null;
  if (!answer) return null;
  const earlier = said.slice(0, -1).join(" ").trim();
  if (question.open && question.running) return { answer, late: false, earlier };
  const late = !question.open && question.closedAt !== null && question.now - question.closedAt < LATE_ANSWER_MS;
  return late ? { answer, late: true, earlier } : null;
}

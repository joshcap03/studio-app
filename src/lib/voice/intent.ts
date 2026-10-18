// What the member's own words on a call ask for, read from the speech-to-text transcript (never
// from the voice front's paraphrase). Deliberately strict: a card is sent only on a clear
// "send", the work stops only on a clear "stop", and only a clear "stop" or "actually…" redirects
// a running job, because redirecting aborts it and declines any pending approval. Pure.

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

import { talksMachinery } from "@/lib/agent/tools";
import type { ActivityStep, ChatMessage, JourneyStep, StreamEvent, UiBlock } from "@/lib/types";

// What the voice may say about the worker's progress on a call, built only from what the
// backend reported: step labels as they start, the agent's own opening lines, journey notes,
// the reply, and the cards it put on screen. Nothing is invented or paraphrased; text is only
// cleaned for the ear (markdown, links, citation marks) and cut to its gist, with the details
// left on screen. Covered for every tool in the flow's history by `npm run test:audit`. Pure.

export type RelayKind = "progress" | "note" | "journey" | "reply" | "card" | "approval" | "problem";

export interface RelayLine {
  kind: RelayKind;
  text: string;
  /** Fine to drop when newer progress comes before it's said. */
  droppable: boolean;
}

export interface RelayState {
  /** Steps and notes already said this turn, by step id. */
  said: string[];
}

export const initialRelay = (): RelayState => ({ said: [] });

/** Text a step's label would be dropped for: raw data or talk of the agent's own machinery. */
const TECHNICAL = /[{}<>[\]`|]|https?:\/\/|\b(null|undefined|nonetype|traceback)\b|\w+_\w+\(/i;
const MAX_LINE = 160;

/** Whether a label may be said aloud as-is. */
export function speakableLabel(label: string): boolean {
  const text = label.trim();
  return text.length > 0 && text.length <= MAX_LINE && !TECHNICAL.test(text) && !talksMachinery(text);
}

/**
 * The step lines for one event: a step said once, when it starts (or, for the agent's own
 * lines, when it says them). Hidden steps and anything unspeakable stay quiet.
 */
export function relayEvent(state: RelayState, event: StreamEvent): { state: RelayState; lines: RelayLine[] } {
  if (event.type === "start") return { state: initialRelay(), lines: [] };
  if (event.type !== "activity") return { state, lines: [] };
  const line = stepLine(event.step);
  if (!line || state.said.includes(event.step.id)) return { state, lines: [] };
  return { state: { said: [...state.said, event.step.id] }, lines: [line] };
}

function stepLine(step: ActivityStep): RelayLine | null {
  if (step.hidden || !speakableLabel(step.label)) return null;
  if (step.action === "note") return { kind: "note", text: step.label.trim(), droppable: true };
  if (step.status !== "running") return null;
  return { kind: "progress", text: `${step.label.trim().replace(/[.…]+$/, "")}…`, droppable: true };
}

/** What finishing a journey step gave the agent, said once as the rail fills in. */
export function relayJourney(before: JourneyStep[], after: JourneyStep[]): RelayLine[] {
  return after.flatMap((step, i) => {
    const was = before.find((s) => s.text === step.text) ?? before[i];
    const note = step.note?.trim();
    if (step.status !== "done" || was?.status === "done" || !note || !speakableLabel(note)) return [];
    return [{ kind: "journey" as const, text: sentence(note), droppable: false }];
  });
}

/** What to say when a reply ends: its gist, then what it asks of the member. */
export function relayReply(message: ChatMessage): RelayLine[] {
  const lines: RelayLine[] = [];
  if (message.status === "error") {
    return [{ kind: "problem", text: `That didn't work. ${sentence(message.error ?? "Something went wrong.")} Say “try again”, or tap Retry.`, droppable: false }];
  }
  if (message.status === "interrupted") {
    return [{ kind: "problem", text: "That got cut off before it finished. Say “try again”, or tap Retry.", droppable: false }];
  }
  if (message.status === "stopped") return [{ kind: "problem", text: "Stopped.", droppable: false }];
  const gist = speakableGist(message.content);
  if (gist) lines.push({ kind: "reply", text: gist, droppable: false });
  for (const q of message.questions ?? []) lines.push({ kind: "card", text: questionLine(q.question, q.options.map((o) => o.label), q.multiSelect), droppable: false });
  for (const block of message.ui ?? []) {
    if (message.uiResponse?.[block.id]) continue;
    lines.push({ kind: "card", text: cardLine(block), droppable: false });
  }
  const pending = message.approvals?.find((a) => a.status === "pending");
  if (message.status === "awaiting" && pending) {
    lines.push({ kind: "approval", text: `It needs your OK on screen: ${sentence(pending.summary)} That one's a tap.`, droppable: false });
  }
  return lines;
}

function questionLine(question: string, options: string[], multi: boolean): string {
  const list = options.length > 1 ? `${options.slice(0, -1).join(", ")}, ${multi ? "and" : "or"} ${options.at(-1)}` : (options[0] ?? "");
  return `${sentence(plain(question))}${list ? ` ${list}.` : ""}`;
}

/** A card's title (and intro), with how to answer it by voice. Fixed words, the card's own content. */
export function cardLine(block: UiBlock): string {
  if (block.kind === "proposal") return `${block.summary ? `${sentence(plain(block.summary))} ` : ""}It's on screen. Tap Apply when it looks right.`;
  const intro = block.intro ? ` ${sentence(plain(block.intro))}` : "";
  const taps = block.fields.some((f) => f.kind === "file" || f.kind === "connect");
  return `${sentence(plain(block.title))}${intro} Tell me your answers${taps ? " (files and apps are taps)" : ""}, and say “send” when it's right.`;
}

const MAX_GIST = 320;

/**
 * A reply cleaned for the ear and cut to its first two sentences: links become their text,
 * citation marks, code, tables, and list markers go, and "The rest is on screen" says where the
 * details went. A greeting the voice already said ("Hey!") isn't said twice.
 */
export function speakableGist(markdown: string): string {
  const text = plain(markdown).replace(/^(hey|hi|hello)( there)?[!,.]\s*/i, "");
  if (!text) return "";
  const sentences = text.match(/[^.!?]+[.!?]+["”’)]*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  let gist = "";
  for (const s of sentences.slice(0, 2)) {
    if (gist && gist.length + s.length + 1 > MAX_GIST) break;
    gist = gist ? `${gist} ${s}` : s;
  }
  if (gist.length > MAX_GIST) gist = `${gist.slice(0, MAX_GIST - 1).replace(/\s+\S*$/, "")}…`;
  // A reply that ends by asking them something always gets that question said, last, so the
  // call asks exactly what the chat asks.
  const last = sentences.at(-1) ?? "";
  const question = /\?["”’)]*$/.test(last) && !gist.includes(last) && last.length <= MAX_GIST ? last : "";
  const rest = text.length > gist.length + question.length + 2;
  return [gist, rest ? "The rest is on screen." : "", question].filter(Boolean).join(" ");
}

/** Markdown to plain words for speech. */
export function plain(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
    .replace(/<?https?:\/\/[^\s>)]+>?/g, " ")
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/[*_#`|<>[\]{}]/g, " ")
    .replace(/\s*\n+\s*/g, (m) => (/\n\s*\n/.test(m) ? ". " : " "))
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/([.!?])\s*\.(\s|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

function sentence(text: string): string {
  const t = text.trim();
  return !t ? "" : /[.!?…]$/.test(t) ? t : `${t}.`;
}

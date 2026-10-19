import { z } from "zod";
import { isBackchannel, isRedirect, isSendIntent, isStopIntent } from "./intent";
import { mockReplyToRefusals, mockReplyToSpeech, type BrainReply } from "./mock";
import { plain } from "./relay";
import { cueLine, greeting, VOICE_TOOLS, voicePrompt } from "./persona";
import { VOICE_CUES, VOICE_MARKER, VOICE_TOOL_NAMES, type VoiceContext, type VoiceMarker, type VoiceStage } from "./types";

// The voice front: an OpenAI-compatible chat-completions endpoint the voice provider calls for
// every turn of a call (ElevenLabs' custom-LLM mode). It ignores the provider's own prompt and
// builds its own per call, guardrail first. Lines from Studio (relay updates, cues, the
// greeting) are said word for word, without a model; only the member's speech and tool results
// go to the model, which may do the four speech acts and call the browser's tools. Pure except
// for the upstream model call.

const content = z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()), z.null()]).optional();

const message = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
    content,
    tool_calls: z
      .array(z.object({ id: z.string().optional(), type: z.string().optional(), function: z.object({ name: z.string(), arguments: z.string().optional() }).loose() }).loose())
      .optional(),
    tool_call_id: z.string().optional(),
  })
  .loose();
export type FrontMessage = z.infer<typeof message>;

export const frontRequest = z
  .object({
    messages: z.array(message).max(500),
    tools: z.array(z.object({ type: z.string().optional(), function: z.object({ name: z.string() }).loose() }).loose()).max(64).optional(),
  })
  .loose();
export type FrontRequest = z.infer<typeof frontRequest>;

const stageField = z
  .object({
    id: z.string().max(80),
    label: z.string().max(300),
    kind: z.string().max(30),
    required: z.boolean(),
    options: z.array(z.string().max(200)).max(20).optional(),
    items: z.array(z.object({ n: z.number(), id: z.string().max(80), title: z.string().max(300) })).max(12).optional(),
    scale: z.object({ steps: z.number(), low: z.string().max(200), high: z.string().max(200) }).optional(),
    reasons: z.array(z.string().max(200)).max(8).optional(),
    current: z.string().max(400).optional(),
    tapOnly: z.boolean().optional(),
  })
  .strip();
const stage = z
  .object({
    working: z.boolean(),
    journey: z.object({ done: z.number(), total: z.number(), current: z.string().max(200).nullable() }).optional(),
    form: z.object({ id: z.string().max(80), title: z.string().max(300), fields: z.array(stageField).max(10) }).optional(),
    questions: z.array(z.object({ question: z.string().max(500), options: z.array(z.string().max(200)).max(6), multi: z.boolean() })).max(4).optional(),
    proposal: z.string().max(600).optional(),
    approval: z.string().max(600).optional(),
  })
  .strip();
const marker = z.object({ say: z.array(z.string().max(600)).max(8).optional(), stage: stage.optional(), cue: z.enum(VOICE_CUES).optional() }).strip();

/** The tool calls the voice front deals in; anything else is the provider's own. */
const ALLOWED_CALLS = new Set<string>([...VOICE_TOOL_NAMES, "skip_turn", "end_call"]);

export function textOf(c: FrontMessage["content"]): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => p.text ?? "").join("");
  return "";
}

/** A Studio marker in a message (any role: providers may deliver contextual updates as system or user text). */
export function readMarker(m: FrontMessage): VoiceMarker | null {
  const text = markerText(m);
  if (text === null) return null;
  try {
    const parsed = marker.safeParse(JSON.parse(text.slice(VOICE_MARKER.length)));
    return parsed.success ? (parsed.data as VoiceMarker) : {};
  } catch {
    return {};
  }
}

/**
 * A message's marker text: its content, or, for ElevenLabs' contextual updates (which reach the
 * model as an assistant `contextual_update` tool call), a string in the call's arguments.
 */
function markerText(m: FrontMessage): string | null {
  const text = textOf(m.content).trim();
  if (text.startsWith(VOICE_MARKER)) return text;
  for (const call of m.tool_calls ?? []) {
    if (ALLOWED_CALLS.has(call.function.name)) continue;
    try {
      const args = JSON.parse(call.function.arguments ?? "{}") as unknown;
      const found = (args && typeof args === "object" ? Object.values(args) : []).find((v): v is string => typeof v === "string" && v.trim().startsWith(VOICE_MARKER));
      if (found) return found.trim();
    } catch {
      // not JSON: not ours
    }
  }
  return null;
}

/**
 * The call as the voice front reads it: no provider prompt, and none of the provider's own tool
 * traffic (contextual updates arrive as tool calls and their results). With `markers`, Studio's
 * marked messages stay in.
 */
function callTurns(messages: FrontMessage[], { markers = false } = {}): FrontMessage[] {
  const foreign = new Set<string>();
  const out: FrontMessage[] = [];
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") continue;
    if (m.role === "assistant" && m.tool_calls?.length) {
      for (const call of m.tool_calls) if (!ALLOWED_CALLS.has(call.function.name) && call.id) foreign.add(call.id);
    }
    if (m.role === "tool" && m.tool_call_id && foreign.has(m.tool_call_id)) continue;
    if (readMarker(m)) {
      if (markers) out.push(m);
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      const ours = m.tool_calls.filter((call) => ALLOWED_CALLS.has(call.function.name));
      if (!ours.length && !textOf(m.content).trim()) continue;
      out.push({ ...m, tool_calls: ours.length ? ours : undefined });
      continue;
    }
    out.push(m);
  }
  return out;
}

/** The stage the browser last reported. */
export function latestStage(messages: FrontMessage[]): VoiceStage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = readMarker(messages[i]);
    if (m?.stage) return m.stage;
  }
  return null;
}

/** Said word for word: no markup, no control characters, short. */
export function sayable(text: string, max = 500): string {
  const line = text
    .replaceAll(VOICE_MARKER, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : line;
}

export type FrontPlan = { kind: "say"; text: string } | { kind: "skip" } | { kind: "model" };

/** Whether the voice said something since the member last spoke (with its tool calls). */
function alreadySaid(messages: FrontMessage[]): boolean {
  const turns = callTurns(messages);
  for (let i = turns.length - 1; i >= 0; i--) {
    const m = turns[i];
    if (m.role === "user") return false;
    if (m.role === "assistant" && textOf(m.content).trim()) return true;
  }
  return false;
}

/** The tool results at the end of the conversation, oldest first. */
function trailingResults(messages: FrontMessage[]): string[] {
  const turns = callTurns(messages);
  const results: string[] = [];
  for (let i = turns.length - 1; i >= 0 && turns[i].role === "tool"; i--) results.unshift(textOf(turns[i].content));
  return results;
}

/**
 * What to say after the browser ran the voice's tools, built from what each reported (fixed
 * words, the member's own answers): "On it.", "Got it: Keep 1, Keep 2.", "Sent.". Null when one
 * was turned down, so the model can fix its call or ask.
 */
export function speechForResults(results: string[]): string | null {
  const filled: string[] = [];
  const lines: string[] = [];
  for (const r of results) {
    const [status, ...rest] = r.split(":");
    const detail = rest.join(":").trim();
    switch (status.trim().toLowerCase()) {
      case "filled":
        filled.push(detail.replace(/\.?\s*not sent yet\.?$/i, "").trim());
        break;
      case "heard":
        lines.push(`Did you mean ${detail.split("?")[0].trim()}? Tap it on screen if so.`);
        break;
      case "handed off":
        lines.push("On it.");
        break;
      case "held":
        lines.push(/\bOK\b/.test(detail) ? "Got it. That goes along after your OK on screen." : "Got it. I'll add that when this lands.");
        break;
      case "sent":
        lines.push("Sent.");
        break;
      case "stopped":
        lines.push("Stopped.");
        break;
      default:
        return null;
    }
  }
  if (filled.length) lines.unshift(`Got it: ${filled.filter(Boolean).join("; ")}.`);
  return lines.length ? sayable([...new Set(lines)].join(" ")) : null;
}

/**
 * What to do with this request: say Studio's line verbatim, stay quiet, or ask the model
 * (only for the member's own speech and tool results).
 */
export function planReply(context: VoiceContext, messages: FrontMessage[]): FrontPlan {
  const turns = callTurns(messages, { markers: true });
  const spoken = turns.some((m) => m.role === "assistant" && !readMarker(m) && (textOf(m.content).trim() || m.tool_calls?.length));
  const stageNow = latestStage(messages);
  const last = turns.at(-1);
  if (!last) return { kind: "say", text: greeting(context, stageNow) };
  const mark = readMarker(last);
  if (mark) {
    if (mark.cue === "hello") return spoken ? { kind: "skip" } : { kind: "say", text: greeting(context, stageNow) };
    if (mark.cue) return { kind: "say", text: cueLine(mark.cue, context, stageNow) };
    const lines = (mark.say ?? []).map((l) => sayable(l)).filter(Boolean);
    return lines.length ? { kind: "say", text: sayable(lines.join(" "), 900) } : { kind: "skip" };
  }
  if (last.role === "assistant") return { kind: "skip" };
  if (last.role === "user" && !textOf(last.content).trim()) return { kind: "skip" };
  if (last.role === "tool") {
    const results = trailingResults(messages);
    // The line already went out with the call (quickRoute), and the result is what it said.
    if (alreadySaid(messages) && results.every((r) => /^\s*(handed off|held|stopped):/i.test(r))) return { kind: "skip" };
    const speech = speechForResults(results);
    if (speech) return { kind: "say", text: speech };
  }
  return { kind: "model" };
}

/** The conversation as the model sees it: no provider prompt, no Studio markers. */
export function modelMessages(context: VoiceContext, messages: FrontMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ role: "system", content: voicePrompt(context, latestStage(messages)) }];
  for (const m of callTurns(messages)) {
    if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.tool_call_id ?? "", content: textOf(m.content).slice(0, 2000) });
    else if (m.role === "assistant") out.push({ role: "assistant", content: textOf(m.content) || null, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) });
    else out.push({ role: "user", content: textOf(m.content).slice(0, 4000) });
  }
  return out;
}

const SYSTEM_TOOLS = new Set(["skip_turn", "end_call"]);
const SKIP_TURN = {
  type: "function",
  function: { name: "skip_turn", description: "Say nothing this turn and wait for the member.", parameters: { type: "object", properties: { reason: { type: "string" } } } },
};

/**
 * The tools the model may call: Studio's own definitions of its client tools (only those the
 * provider can deliver, when it lists any), plus the provider's turn tools (skip_turn, end_call).
 */
export function modelTools(requested: FrontRequest["tools"]): Record<string, unknown>[] {
  const names = new Set((requested ?? []).map((t) => t.function.name));
  const ours = VOICE_TOOL_NAMES.filter((n) => !requested?.length || names.has(n)).map((name) => ({
    type: "function",
    function: { name, description: VOICE_TOOLS[name].description, parameters: VOICE_TOOLS[name].parameters },
  }));
  const system = (requested ?? []).filter((t) => SYSTEM_TOOLS.has(t.function.name));
  return [...ours, ...(system.length ? system : [SKIP_TURN])];
}

/** The scripted mock's answer to the latest turn. */
export function mockReply(messages: FrontMessage[]): BrainReply {
  const turns = callTurns(messages);
  const results = trailingResults(messages);
  if (results.length) return mockReplyToRefusals(results);
  const said = turns.at(-1)?.role === "user" ? textOf(turns.at(-1)!.content) : "";
  return said.trim() ? mockReplyToSpeech(latestStage(messages), said) : { tools: [{ name: "skip_turn", args: {} }] };
}

// ------------------------------------------------------------------------------------------
// Server-sent events, the OpenAI chat-completions streaming format.

const encoder = new TextEncoder();

function chunk(id: string, delta: Record<string, unknown>, finish: string | null = null): Uint8Array {
  const body = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "studio-voice", choices: [{ index: 0, delta, finish_reason: finish }] };
  return encoder.encode(`data: ${JSON.stringify(body)}\n\n`);
}

/** A whole reply (text and/or tool calls) as one short event stream. */
export function replyStream(reply: BrainReply): ReadableStream<Uint8Array> {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(chunk(id, { role: "assistant", content: reply.text ? "" : null }));
      if (reply.text) controller.enqueue(chunk(id, { content: reply.text }));
      reply.tools?.forEach((t, index) => {
        controller.enqueue(
          chunk(id, { tool_calls: [{ index, id: `call_${crypto.randomUUID().slice(0, 12)}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } }] }),
        );
      });
      controller.enqueue(chunk(id, {}, reply.tools?.length ? "tool_calls" : "stop"));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

export const LOST_LINE = "Sorry, I lost that. Could you say it again?";

/**
 * What happens with what the member said: clear commands and backchannels by fixed rules, the
 * rest as the model chose. The member's words go to the work whenever the model called nothing,
 * so the call never asks questions of its own and the chat stays the one record of it.
 */
export function routeSpeech(said: string, stage: VoiceStage | null, tools: BrainReply["tools"] = []): BrainReply {
  const skip = { tools: [{ name: "skip_turn", args: {} }] };
  if (isBackchannel(said)) return skip;
  if (isStopIntent(said)) return { tools: [{ name: "stop_work", args: {} }] };
  const fills = (tools ?? []).filter((t) => t.name === "fill_card" || t.name === "answer_question");
  // "Send" sends what's on screen; the browser says what's missing if it can't.
  if (isSendIntent(said) && (stage?.form || stage?.questions?.length)) return { tools: [...fills, { name: "send_card", args: {} }] };
  const chosen = (tools ?? []).filter((t) => t.name !== "skip_turn" && t.name !== "stop_work" && t.name !== "send_card");
  return chosen.length ? { tools: chosen } : { tools: [{ name: "send_message", args: {} }] };
}

/**
 * The turn decided without a model, when there's nothing to interpret: the member spoke and no
 * card is on screen, so their words go to the work (or stay quiet, or stop it) straight away.
 * Most of a setup is plain questions, so this is most turns, about a second faster. Null when
 * the model is needed (a card to fill from what they said).
 */
export function quickRoute(messages: FrontMessage[]): BrainReply | null {
  const last = callTurns(messages).at(-1);
  if (last?.role !== "user") return null;
  const stage = latestStage(messages);
  if (stage?.form || stage?.questions?.length) return null;
  const said = textOf(last.content);
  const reply = routeSpeech(said, stage, []);
  // The holding line goes out with the hand-off, in one turn rather than two.
  const call = reply.tools?.[0]?.name;
  if (call === "send_message") {
    const held = stage?.approval ? "Got it. That goes along after your OK on screen." : stage?.working && !isRedirect(said) ? "Got it. I'll add that when this lands." : "On it.";
    return { ...reply, text: held };
  }
  if (call === "stop_work") return stage?.working ? { ...reply, text: "Stopping." } : { tools: [{ name: "skip_turn", args: {} }] };
  return reply;
}

const TOOL_WORDS = /\b(skip[_ ]turn|end[_ ]call|send[_ ]message|fill[_ ]card|send[_ ]card|stop[_ ]work|answer[_ ]question|tools?|field id)\b/i;

/**
 * What the model may say aloud when it calls no tool (a short question back): plain words, two
 * sentences at most, and nothing about its machinery. Empty when there's nothing sayable.
 */
export function spokenText(raw: unknown): string {
  const original = typeof raw === "string" ? raw : "";
  const text = plain(original);
  if (!text || TOOL_WORDS.test(original) || TOOL_WORDS.test(text)) return "";
  const sentences = text.match(/[^.!?]+[.!?]+["”’)]*|[^.!?]+$/g)?.map((x) => x.trim()) ?? [text];
  return sayable(sentences.slice(0, 2).join(" "), 240);
}


/**
 * The model's turn, from an OpenAI-compatible endpoint. It chooses what to do; it only gets to
 * word what's said when it calls no tool. With a tool call its text is dropped: Studio says a
 * fixed line once the tool reports (speechForResults). A failure is a spoken line, since the
 * provider expects errors inside the stream.
 */
export async function modelReply(
  llm: { baseUrl: string; apiKey: string; model: string; extraBody?: Record<string, unknown> },
  context: VoiceContext,
  request: FrontRequest,
  signal: AbortSignal,
): Promise<BrainReply> {
  try {
    const res = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({
        // Provider-specific settings first, so they can't replace the call's own fields.
        ...llm.extraBody,
        model: llm.model,
        messages: modelMessages(context, request.messages),
        tools: modelTools(request.tools),
        tool_choice: "auto",
        stream: false,
        // Room for a few fill_card calls at once; what it says is capped separately (spokenText).
        max_tokens: 600,
        temperature: 0.4,
      }),
      signal,
    });
    if (!res.ok) {
      console.error("[voice] model call failed", res.status);
      return { text: LOST_LINE };
    }
    const body = (await res.json()) as { choices?: { message?: { content?: unknown; tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[] };
    const message = body.choices?.[0]?.message;
    const tools = (message?.tool_calls ?? []).flatMap((t) => {
      const name = t.function?.name ?? "";
      if (!ALLOWED_CALLS.has(name)) return [];
      let args: Record<string, unknown> = {};
      try {
        args = t.function?.arguments ? (JSON.parse(t.function.arguments) as Record<string, unknown>) : {};
      } catch {
        // malformed arguments: the tool sees none
      }
      return [{ name, args }];
    });
    const last = callTurns(request.messages).at(-1);
    if (last?.role === "user") return routeSpeech(textOf(last.content), latestStage(request.messages), tools);
    if (tools.length) return { tools };
    // Only after a tool was turned down may the model say why, in a few words.
    const text = spokenText(message?.content);
    return text ? { text } : { tools: [{ name: "skip_turn", args: {} }] };
  } catch (e) {
    if (!signal.aborted) console.error("[voice] model call failed", e);
    return { text: LOST_LINE };
  }
}

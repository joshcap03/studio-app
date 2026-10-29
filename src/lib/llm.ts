import type { z } from "zod";
import type { LlmConfig } from "@/lib/config";

// Studio's own small model: one short, non-streaming call to an OpenAI-compatible endpoint, for
// decisions the app makes itself (which agent takes an ask from Home) and for the voice front's
// turn. Never the agent: agent reasoning stays in the flow. Nothing here logs what was sent.

export type { LlmConfig };

export interface ChatMessageIn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionBody {
  /** Plain turns, or the provider's richer message shapes (tool results, say) as the caller built them. */
  messages: (ChatMessageIn | Record<string, unknown>)[];
  max_tokens: number;
  temperature?: number;
  tools?: unknown;
  tool_choice?: unknown;
}

export interface ChatCompletionReply {
  /** The assistant's text, as the provider sent it (a string, or nothing with a tool call). */
  content: unknown;
  toolCalls: { name: string; arguments: string }[];
}

/** One chat completion. Throws on a non-2xx response or a network failure (the status is on the error). */
export async function chatCompletion(llm: LlmConfig, body: ChatCompletionBody, signal?: AbortSignal): Promise<ChatCompletionReply> {
  const res = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
    // Provider-specific settings first, so they can't replace the call's own fields.
    body: JSON.stringify({ ...llm.extraBody, model: llm.model, ...body, stream: false }),
    signal,
  });
  if (!res.ok) throw Object.assign(new Error(`model call failed: ${res.status}`), { status: res.status });
  const data = (await res.json()) as { choices?: { message?: { content?: unknown; tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[] };
  const message = data.choices?.[0]?.message;
  return {
    content: message?.content,
    toolCalls: (message?.tool_calls ?? []).map((t) => ({ name: t.function?.name ?? "", arguments: t.function?.arguments ?? "" })),
  };
}

export const COMPLETE_JSON_TIMEOUT_MS = 4000;

/**
 * A short JSON answer, checked against `schema`: null on any failure (a timeout, a bad status,
 * no JSON in the reply, or a shape the schema refuses). Never throws, so a caller can fall back.
 */
export async function completeJson<T>(
  llm: LlmConfig,
  { system, user, schema, maxTokens = 60, timeoutMs = COMPLETE_JSON_TIMEOUT_MS }: { system: string; user: string; schema: z.ZodType<T>; maxTokens?: number; timeoutMs?: number },
): Promise<T | null> {
  try {
    const reply = await chatCompletion(
      llm,
      { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: maxTokens, temperature: 0 },
      AbortSignal.timeout(timeoutMs),
    );
    const json = jsonIn(reply.content);
    if (json === null) return null;
    const parsed = schema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The first JSON object in a model's text (fences and chatter around it dropped), or null. */
export function jsonIn(content: unknown): unknown | null {
  if (typeof content !== "string") return null;
  const text = content.replace(/```(?:json)?/gi, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

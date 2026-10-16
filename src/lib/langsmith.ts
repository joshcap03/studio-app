import type { MessageFeedback } from "@/lib/types";

// Sends members' reply ratings to LangSmith, as feedback on the trace of the run that wrote
// the reply, so they can feed evals. Each reply has at most one: its feedback id is the
// reply's id, so rating again replaces it (LangSmith upserts on id) and clearing deletes it.
// Ratings carry no member or workspace ids; the trace already holds the conversation.

export const FEEDBACK_KEY = "user_rating";
const TIMEOUT_MS = 10_000;

export interface LangsmithConfig {
  apiKey: string;
  endpoint: string;
  fetch?: typeof fetch;
}

/** The feedback LangSmith gets for a rating: 1 for up, 0 for down, the reasons and note as the comment. */
export function feedbackBody(traceId: string, replyId: string, feedback: MessageFeedback) {
  const comment = [feedback.reasons.join(", "), feedback.note?.trim()].filter(Boolean).join(" — ");
  return {
    id: replyId,
    run_id: traceId,
    key: FEEDBACK_KEY,
    score: feedback.rating === "up" ? 1 : 0,
    value: feedback.rating,
    comment: comment || null,
    extra: { reasons: feedback.reasons },
    feedback_source: { type: "app" },
  };
}

/** Puts a reply's rating on its trace, or removes it when `feedback` is null. Throws on failure. */
export async function sendRating(config: LangsmithConfig, traceId: string, replyId: string, feedback: MessageFeedback | null): Promise<void> {
  const doFetch = config.fetch ?? fetch;
  const base = config.endpoint.endsWith("/") ? config.endpoint : `${config.endpoint}/`;
  const headers = { "x-api-key": config.apiKey, "Content-Type": "application/json" };
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const response = feedback
    ? await doFetch(new URL("api/v1/feedback", base), { method: "POST", headers, body: JSON.stringify(feedbackBody(traceId, replyId, feedback)), signal })
    : await doFetch(new URL(`api/v1/feedback/${encodeURIComponent(replyId)}`, base), { method: "DELETE", headers, signal });
  // Clearing a rating that never reached LangSmith is fine.
  if (!feedback && response.status === 404) return;
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`LangSmith feedback ${feedback ? "POST" : "DELETE"} failed (${response.status}): ${detail.slice(0, 300)}`);
  }
}

/**
 * Brings a reply's trace feedback in line with its stored rating. Reads the rating again
 * rather than taking the one just written, so of several quick changes the last one wins.
 * No-op without LangSmith configured or a trace for the reply.
 */
export async function syncRating(
  store: { ratedReply(conversationId: string, id: string): Promise<{ feedback: MessageFeedback | null; traceId: string | null } | null> },
  conversationId: string,
  replyId: string,
  config: LangsmithConfig | undefined,
): Promise<void> {
  if (!config) return;
  const reply = await store.ratedReply(conversationId, replyId);
  if (!reply?.traceId) return;
  await sendRating(config, reply.traceId, replyId, reply.feedback);
}

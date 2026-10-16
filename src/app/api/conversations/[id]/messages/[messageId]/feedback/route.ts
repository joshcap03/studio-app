import { after, NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, parseBody } from "@/lib/api";
import { storeFor } from "@/lib/chat/store-for";
import { getConfig } from "@/lib/config";
import { syncRating } from "@/lib/langsmith";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { FEEDBACK_REASONS, MAX_FEEDBACK_NOTE_LENGTH, type MessageFeedback } from "@/lib/types";

type Context = { params: Promise<{ id: string; messageId: string }> };

const reasons = (rating: MessageFeedback["rating"]) => z.array(z.enum(FEEDBACK_REASONS[rating])).max(FEEDBACK_REASONS[rating].length);
const note = z.string().trim().max(MAX_FEEDBACK_NOTE_LENGTH).optional();
const body = z.object({
  feedback: z
    .discriminatedUnion("rating", [
      z.object({ rating: z.literal("up"), reasons: reasons("up").default([]), note }),
      z.object({ rating: z.literal("down"), reasons: reasons("down").default([]), note }),
    ])
    .nullable(),
});

/** Rates one of the caller's replies (thumbs up or down, and why), or clears the rating. */
export async function PUT(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const ids = z.object({ id: z.uuid(), messageId: z.uuid() }).safeParse(await params);
  if (!ids.success) return jsonError(404, "Message not found.");
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;
  const feedback: MessageFeedback | null = input.feedback
    ? { rating: input.feedback.rating, reasons: [...new Set(input.feedback.reasons)], ...(input.feedback.note ? { note: input.feedback.note } : {}) }
    : null;
  try {
    const store = storeFor(auth.value);
    const found = await store.setFeedback(ids.data.id, ids.data.messageId, feedback);
    if (!found) return jsonError(404, "Message not found.");
    // Also onto the run's trace, for evals. The member's rating is saved either way.
    const langsmith = getConfig().langsmith;
    if (langsmith) after(() => syncRating(store, ids.data.id, ids.data.messageId, langsmith).catch((e) => console.error("[feedback] couldn't send the rating to LangSmith", e)));
    return NextResponse.json({ feedback });
  } catch (error) {
    return errorResponse(error);
  }
}

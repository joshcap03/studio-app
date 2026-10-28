import { logger, task } from "@trigger.dev/sdk";
import { continueChatInApp } from "@/lib/chat/continue-in-app";
import { asMember, MemberUnavailable, replyWaiting, SignInRateLimited } from "./lib/elevated";

// Carries on a chat reply's job (keep_going) when the member's page doesn't, so a long job goes on
// with no Studio tab open. The app hands each such reply here, a little after it ends
// (src/lib/chat/keep-going.ts). If it's still waiting (the page didn't carry it on, the member
// didn't write or stop), the worker signs in as the member and the app runs the next reply
// (POST /api/conversations/<id>/keep-going), as them under RLS, exactly like their page would.
// That reply hands itself on in turn, up to the app's cap; the member is notified when the job ends.

export interface ContinueChatPayload {
  conversationId: string;
  /** The reply that carries the job on. */
  replyId: string;
  workspaceId: string;
  userId: string;
  /** Times this was put back because sign-in was rate limited. */
  deferred?: number;
}

const MAX_DEFERRALS = 5;
// The app's replies stop at its function limit (300s); give the answer a little longer to arrive.
const APP_TIMEOUT_MS = 320_000;

function appUrl(): string {
  const value = process.env.APP_URL?.trim();
  if (!value) throw new Error("APP_URL is not set");
  return value;
}

export const continueChat = task({
  id: "continue-chat",
  // Never retried blindly: the agent may have done work. The member's page carries it on when opened.
  retry: { maxAttempts: 1 },
  queue: { concurrencyLimit: 10 },
  maxDuration: 600,
  run: async (payload: ContinueChatPayload) => {
    if (!(await replyWaiting(payload))) {
      logger.info("nothing to carry on", { replyId: payload.replyId });
      return { status: "taken" };
    }
    try {
      // The session stays open until the app answers, so the reply's queries keep a live sign-in.
      const outcome = await asMember(payload.userId, (accessToken) => continueChatInApp(appUrl(), payload, accessToken, { timeoutMs: APP_TIMEOUT_MS }));
      logger.info("carried on", { replyId: payload.replyId, ...outcome });
      return outcome;
    } catch (error) {
      if (error instanceof SignInRateLimited && (payload.deferred ?? 0) < MAX_DEFERRALS) {
        const deferred = (payload.deferred ?? 0) + 1;
        logger.warn("sign-in rate limited; deferring", { replyId: payload.replyId, deferred });
        await continueChat.trigger({ ...payload, deferred }, { delay: `${deferred}m`, idempotencyKey: `${payload.replyId}:deferred:${deferred}`, idempotencyKeyTTL: "1d" });
        return { status: "deferred" };
      }
      if (error instanceof MemberUnavailable) {
        logger.warn(error.message, { replyId: payload.replyId });
        return { status: "refused", reason: "member_unavailable" };
      }
      // The reply stays as it is, carrying the job on: the member's page carries it on when opened.
      logger.error("couldn't carry the reply on", { replyId: payload.replyId, error: String(error) });
      throw error;
    }
  },
});

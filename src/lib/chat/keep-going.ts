import { configure, tasks } from "@trigger.dev/sdk";
import { getConfig } from "@/lib/config";
import type { Tenant } from "@/lib/tenant-core";
import type { continueChat } from "../../../trigger/continue-chat";

// A chat reply that carries a job on (keep_going) is carried on by the member's page while it's
// open. So the job goes on with no page open too, each such reply is also handed to the background
// worker (trigger/continue-chat.ts), a little later: it signs in as the member and asks the app to
// carry it on (POST /api/conversations/<id>/keep-going), unless the page already did. The reply is
// claimed by whichever starts first (Store.claimKeepGoing), so only one does.

/** How long the worker leaves the member's page to carry a reply on first. */
export const WORKER_DELAY_S = 15;

let configured: string | null = null;

/**
 * Hands one reply's job to the worker. False when there's no worker here (the page alone carries
 * it on) or it couldn't be handed over; the reply is still carried on whenever the page is open.
 */
export async function handKeepGoingToWorker(tenant: Tenant, conversationId: string, replyId: string): Promise<boolean> {
  const worker = getConfig().keepGoingWorker;
  if (!worker) return false;
  if (configured !== worker.triggerKey) {
    configure({ accessToken: worker.triggerKey });
    configured = worker.triggerKey;
  }
  try {
    await tasks.trigger<typeof continueChat>(
      "continue-chat",
      { conversationId, replyId, workspaceId: tenant.workspace.id, userId: tenant.userId },
      { delay: `${WORKER_DELAY_S}s`, idempotencyKey: `continue-chat:${replyId}`, idempotencyKeyTTL: "1d" },
    );
    return true;
  } catch (error) {
    console.error("[keep-going] couldn't hand the job to the worker:", error instanceof Error ? error.message : error);
    return false;
  }
}

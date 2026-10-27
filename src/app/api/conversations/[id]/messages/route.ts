import { NextResponse, after, type NextRequest } from "next/server";
import { z } from "zod";
import { agentEnabledFor } from "@/lib/agent";
import { errorResponse, parseBody } from "@/lib/api";
import { buildTurnDeps } from "@/lib/chat/run";
import { TurnError, startTurn } from "@/lib/chat/turn";
import { BUILTIN_SKILL_IDS } from "@/lib/skills/builtin";
import { SETUP_SKILL_ID } from "@/lib/skills/setup";
import { getSetup, updateSetup } from "@/lib/setup-state";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { MAX_ATTACHMENTS, MAX_MESSAGE_LENGTH, MODALITIES } from "@/lib/types";

// Starts a turn and streams it back as NDJSON (one StreamEvent per line). Creating the
// conversation on first send lets the browser create conversations optimistically. The
// workspace, user, and agent context all come from the session, never from the request.

export const dynamic = "force-dynamic";
// The run streams inside this request, and keeps going (via after()) if the member closes
// the app. On Vercel this is the most the Hobby plan allows; raise it (up to 800) on Pro, with
// REQUEST_LIMIT_MS (src/lib/chat/run.ts), which stops the run in time to say it ran out.
export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

const text = z.string().trim().min(1).max(MAX_MESSAGE_LENGTH);
// The page asking can show the agent's offer to call. One from before offers says nothing, and
// gets none: it would break on the card.
const offers = z.boolean().optional();
// Likewise its requests for a login or card.
const secrets = z.boolean().optional();
// Likewise the agent's browser handed over.
const handoffs = z.boolean().optional();
const body = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("send"),
      text: z.string().trim().max(MAX_MESSAGE_LENGTH),
      // A skill from the caller's workspace. Only its id comes from the request; the
      // instructions are loaded from the workspace below.
      skillId: z.union([z.uuid(), z.enum(BUILTIN_SKILL_IDS)]).optional(),
      attachmentIds: z.array(z.uuid()).max(MAX_ATTACHMENTS).optional(),
      // Stop the agent if it's still working here (or decline its pending request) and answer this.
      steer: z.boolean().optional(),
      // One of the caller's projects to start a new conversation in. Ignored for existing ones.
      projectId: z.uuid().optional(),
      // How the member is talking: on a call or in a voice message their words were spoken, and the
      // agent writes for the ear. A retry, an edit, or a decision is said the way the latest message was.
      modality: z.enum(MODALITIES).optional(),
      // The call these words were said on, for its recap. It counts only once it's checked to be
      // the caller's own call in this agent (src/lib/chat/run.ts).
      voiceSessionId: z.uuid().optional(),
      // The page they were looking at as they said it, by id; loaded under their session, or ignored.
      screen: z
        .discriminatedUnion("kind", [
          z.object({ kind: z.literal("task"), id: z.uuid() }),
          z.object({ kind: z.literal("tracker"), collection: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/) }),
        ])
        .optional(),
      offers,
      secrets,
      handoffs,
    })
    .refine((b) => b.text.length > 0 || b.skillId, "Write a message."),
  z.object({ kind: z.literal("retry"), offers, secrets, handoffs }),
  z.object({ kind: z.literal("edit"), messageId: z.uuid(), text, offers, secrets, handoffs }),
  z
    .object({
      kind: z.literal("decide"),
      approvalId: z.uuid(),
      decision: z.enum(["approve", "reject"]),
      // Said on a call rather than tapped: what the member was heard to say, and the call. It
      // stands only once checked (src/lib/voice/approvals.ts); otherwise the request stays waiting.
      via: z.enum(["tap", "voice"]).optional(),
      heard: z.string().trim().min(1).max(500).optional(),
      voiceSessionId: z.uuid().optional(),
      // A tap on "Approve, and don't ask again on this task": only an approval, only by hand.
      always: z.literal(true).optional(),
      offers,
      secrets,
      handoffs,
    })
    .refine((b) => !b.always || (b.decision === "approve" && b.via !== "voice"), "Only a tapped approval can be kept for this task.")
    .refine((b) => (b.via === "voice") === (b.heard !== undefined && b.voiceSessionId !== undefined), "A spoken decision needs the words heard and the call."),
]);

export async function POST(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const tenant = auth.value;
  const conversationId = z.uuid().safeParse((await params).id);
  if (!conversationId.success) return jsonError(404, "Conversation not found.");
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;

  if (!agentEnabledFor(tenant.workspace.id)) {
    return jsonError(403, "This agent isn't enabled yet.", "agent_unavailable");
  }

  try {
    // The function stays alive until the run is over, even after the browser disconnects
    // (a phone locked mid-run); a member who wasn't watching gets a notification.
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    const { deps, request: turn } = await buildTurnDeps(tenant, {
      conversationId: conversationId.data,
      // The browser can only grant a standing OK (with its tap); a task's run alone uses one.
      input: input.kind === "decide" ? { ...input, standing: input.always ? "grant" : undefined } : input,
      onFinished: () => settle(),
    });

    // A conversation id that exists for another tenant fails here: the insert collides with
    // a row this tenant cannot see, and the database refuses it.
    const stream = await startTurn(deps, turn);
    if (input.kind === "send" && input.skillId === SETUP_SKILL_ID) {
      // The owner started (or restarted) the agent's setup here: this conversation holds it now.
      const current = await getSetup(tenant).catch(() => null);
      const fresh = current?.conversationId !== conversationId.data;
      await updateSetup(tenant, { status: "in_progress", conversationId: conversationId.data, ...(fresh ? { plan: [], goal: null } : {}) }).catch((e) =>
        console.error("[setup] couldn't record the setup's start", e),
      );
    }
    after(() => settled);
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof TurnError) return jsonError(error.status, error.message, error.status === 429 ? "rate_limited" : undefined);
    if (/duplicate key|violates/.test((error as Error)?.message ?? "")) return jsonError(404, "Conversation not found.");
    return errorResponse(error);
  }
}

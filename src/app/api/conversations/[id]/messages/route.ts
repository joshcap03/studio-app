import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { agentEnabledFor, getAgentAdapter } from "@/lib/agent";
import { errorResponse, parseBody } from "@/lib/api";
import { readAttachment } from "@/lib/attachments";
import { storeFor } from "@/lib/chat/store-for";
import { TurnError, startTurn } from "@/lib/chat/turn";
import { getConfig } from "@/lib/config";
import { getSkill } from "@/lib/skills";
import { BUILTIN_SKILL_IDS } from "@/lib/skills/builtin";
import { previewEnabled } from "@/lib/flags";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { MAX_ATTACHMENTS, MAX_MESSAGE_LENGTH } from "@/lib/types";
import { memoryEnabled, remember } from "@/lib/memory";
import { buildAgentContext, checkRunLimits, recordRun } from "@/lib/workspace";

// Starts a turn and streams it back as NDJSON (one StreamEvent per line). Creating the
// conversation on first send lets the browser create conversations optimistically. The
// workspace, user, and agent context all come from the session, never from the request.

export const dynamic = "force-dynamic";
// The run streams inside this request. On Vercel this is the most the Hobby plan allows;
// raise it (up to 800) on Pro. A run cut off here shows as interrupted, with a retry.
export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

const text = z.string().trim().min(1).max(MAX_MESSAGE_LENGTH);
const body = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("send"),
      text: z.string().trim().max(MAX_MESSAGE_LENGTH),
      // A skill from the caller's workspace. Only its id comes from the request; the
      // instructions are loaded from the workspace below.
      skillId: z.union([z.uuid(), z.enum(BUILTIN_SKILL_IDS)]).optional(),
      attachmentIds: z.array(z.uuid()).max(MAX_ATTACHMENTS).optional(),
    })
    .refine((b) => b.text.length > 0 || b.skillId, "Write a message."),
  z.object({ kind: z.literal("retry") }),
  z.object({ kind: z.literal("edit"), messageId: z.uuid(), text }),
  z.object({ kind: z.literal("decide"), approvalId: z.uuid(), decision: z.enum(["approve", "reject"]) }),
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
    return jsonError(403, "The agent isn't enabled for this workspace yet.", "agent_unavailable");
  }

  try {
    // Context (settings and memory recall) loads alongside the limit and skill checks rather
    // than after them; it only reads, so a refused run just discards it.
    const context = buildAgentContext(tenant, "text" in input ? input.text : undefined);
    context.catch(() => undefined);
    const loadSkill = (id: string) => getSkill(tenant, id);
    const [limit, skill] = await Promise.all([
      checkRunLimits(tenant),
      input.kind === "send" && input.skillId ? loadSkill(input.skillId) : Promise.resolve(undefined),
    ]);
    if (limit) return jsonError(429, limit, "rate_limited");
    if (skill === null) return jsonError(404, "Skill not found.");

    const store = storeFor(tenant);
    // A conversation id that exists for another tenant fails here: the insert collides with
    // a row this tenant cannot see, and the database refuses it.
    const stream = await startTurn(
      {
        store,
        adapter: getAgentAdapter(),
        context: await context,
        remember: memoryEnabled() ? async (content, scope, options) => (await remember(tenant, content, scope, options)).id : undefined,
        idleTimeoutMs: getConfig().agent.idleTimeoutMs,
        timelines: previewEnabled(tenant, "why"),
        loadAttachment: (attachment) => readAttachment(tenant, attachment),
        loadSkill,
      },
      input.kind === "send"
        ? { conversationId: conversationId.data, kind: "send", text: input.text, skill: skill ?? undefined, attachmentIds: input.attachmentIds }
        : { conversationId: conversationId.data, ...input },
    );
    await recordRun(tenant);
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof TurnError) return jsonError(error.status, error.message);
    if (/duplicate key|violates/.test((error as Error)?.message ?? "")) return jsonError(404, "Conversation not found.");
    return errorResponse(error);
  }
}

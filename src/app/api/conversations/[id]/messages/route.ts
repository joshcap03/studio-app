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
import { projectForRun } from "@/lib/projects";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { MAX_ATTACHMENTS, MAX_MESSAGE_LENGTH } from "@/lib/types";
import { memoryEnabled, recallQuery, remember } from "@/lib/memory";
import { buildAgentContext, claimRun } from "@/lib/workspace";

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
      // Stop the agent if it's still working here (or decline its pending request) and answer this.
      steer: z.boolean().optional(),
      // One of the caller's projects to start a new conversation in. Ignored for existing ones.
      projectId: z.uuid().optional(),
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
    // Context (settings and memory recall) loads alongside the skill and project lookups rather
    // than after them; it only reads, so a refused run just discards it.
    // Memory is searched with the member's recent messages, not just this one, so a follow-up
    // recalls what the conversation is about rather than only the business's standing facts.
    const store = storeFor(tenant);
    const context = store
      .listMessages(conversationId.data)
      .then((messages) => {
        const end = input.kind === "edit" ? messages.findIndex((m) => m.id === input.messageId) : -1;
        const asks = (end < 0 ? messages : messages.slice(0, end)).filter((m) => m.role === "user").map((m) => m.content);
        return "text" in input ? [...asks, input.text] : asks;
      })
      .catch(() => ("text" in input ? [input.text] : []))
      .then((asks) => buildAgentContext(tenant, recallQuery(asks), conversationId.data));
    context.catch(() => undefined);
    const adapter = getAgentAdapter();
    const loadSkill = (id: string) => getSkill(tenant, id);
    // A conversation's project is the one it was started in (or moved to) by its member.
    const loadProject = async () => {
      const conversation = await store.getConversation(conversationId.data);
      const projectId = conversation ? conversation.projectId : input.kind === "send" ? input.projectId : undefined;
      return projectId ? projectForRun(tenant, projectId, adapter.capabilities.attachments) : undefined;
    };
    const [skill, project] = await Promise.all([
      input.kind === "send" && input.skillId ? loadSkill(input.skillId) : Promise.resolve(undefined),
      loadProject(),
    ]);
    if (skill === null) return jsonError(404, "Skill not found.");
    if (project === null) return jsonError(404, "Project not found.");

    // A conversation id that exists for another tenant fails here: the insert collides with
    // a row this tenant cannot see, and the database refuses it.
    const stream = await startTurn(
      {
        store,
        adapter,
        context: { ...(await context), project: project?.context ?? null },
        projectFiles: project?.files,
        remember: memoryEnabled() ? async (content, scope, options) => (await remember(tenant, content, scope, options)).id : undefined,
        idleTimeoutMs: getConfig().agent.idleTimeoutMs,
        // Checks the limits and records the run in one step, so a burst can't slip under them.
        claim: (replyId) => claimRun(tenant, replyId),
        timelines: previewEnabled(tenant, "why"),
        loadAttachment: (attachment) => readAttachment(tenant, attachment),
        loadSkill,
      },
      input.kind === "send"
        ? {
            conversationId: conversationId.data,
            kind: "send",
            text: input.text,
            skill: skill ?? undefined,
            attachmentIds: input.attachmentIds,
            steer: input.steer,
            projectId: input.projectId,
          }
        : { conversationId: conversationId.data, ...input },
    );
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

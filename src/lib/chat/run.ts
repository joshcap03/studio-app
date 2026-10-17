import { getAgentAdapter } from "@/lib/agent";
import { readAttachment } from "@/lib/attachments";
import { storeFor } from "@/lib/chat/store-for";
import { TurnError, type TurnDeps, type TurnRequest } from "@/lib/chat/turn";
import { getConfig } from "@/lib/config";
import { previewEnabled } from "@/lib/flags";
import { memoryEnabled, recallQuery, remember } from "@/lib/memory";
import { projectForRun } from "@/lib/projects";
import { notificationFor, notify, pushEnabled } from "@/lib/push";
import { getSkill } from "@/lib/skills";
import type { Tenant } from "@/lib/tenant-core";
import type { ChatMessage, ConversationSummary } from "@/lib/types";
import { buildAgentContext, claimRun } from "@/lib/workspace";

// Builds everything one turn needs for one member, from their tenant alone: the chat route
// and a background worker run turns the same way. Nothing here touches the request, so it
// stays free of Next.js; keeping the process alive until the run settles is the caller's job.

/** What the member asked for. Skills and projects are named by id and loaded from their workspace. */
export type RunInput =
  | { kind: "send"; text: string; skillId?: string; attachmentIds?: string[]; steer?: boolean; projectId?: string }
  | { kind: "retry" }
  | { kind: "edit"; messageId: string; text: string }
  | { kind: "decide"; approvalId: string; decision: "approve" | "reject" };

export interface RunOptions {
  conversationId: string;
  input: RunInput;
  /** Called after the reply's final state is saved and any notification is sent. */
  onFinished?: NonNullable<TurnDeps["onFinished"]>;
}

/**
 * The deps and request for `startTurn`. Throws a TurnError (404) when the skill or project
 * isn't one of the member's.
 */
export async function buildTurnDeps(
  tenant: Tenant,
  { conversationId, input, onFinished }: RunOptions,
): Promise<{ deps: TurnDeps; request: TurnRequest }> {
  // Context (settings and memory recall) loads alongside the skill and project lookups rather
  // than after them; it only reads, so a refused run just discards it.
  // Memory is searched with the member's recent messages, not just this one, so a follow-up
  // recalls what the conversation is about rather than only the business's standing facts.
  const store = storeFor(tenant);
  const context = store
    .listMessages(conversationId)
    .then((messages) => {
      const end = input.kind === "edit" ? messages.findIndex((m) => m.id === input.messageId) : -1;
      const asks = (end < 0 ? messages : messages.slice(0, end)).filter((m) => m.role === "user").map((m) => m.content);
      return "text" in input ? [...asks, input.text] : asks;
    })
    .catch(() => ("text" in input ? [input.text] : []))
    .then((asks) => buildAgentContext(tenant, recallQuery(asks), conversationId));
  context.catch(() => undefined);
  const adapter = getAgentAdapter();
  const loadSkill = (id: string) => getSkill(tenant, id);
  // A conversation's project is the one it was started in (or moved to) by its member.
  const loadProject = async () => {
    const conversation = await store.getConversation(conversationId);
    const projectId = conversation ? conversation.projectId : input.kind === "send" ? input.projectId : undefined;
    return projectId ? projectForRun(tenant, projectId, adapter.capabilities.attachments) : undefined;
  };
  const [skill, project] = await Promise.all([
    input.kind === "send" && input.skillId ? loadSkill(input.skillId) : Promise.resolve(undefined),
    loadProject(),
  ]);
  if (skill === null) throw new TurnError(404, "Skill not found.");
  if (project === null) throw new TurnError(404, "Project not found.");

  // A member who wasn't watching when the run ended gets a notification.
  const finished = async (message: ChatMessage, conversation: ConversationSummary, info: { watched: boolean }) => {
    try {
      const notification = info.watched || !pushEnabled() ? null : notificationFor(message, conversation);
      if (notification) await notify(tenant, notification);
    } finally {
      await onFinished?.(message, conversation, info);
    }
  };

  const deps: TurnDeps = {
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
    onFinished: finished,
  };
  const request: TurnRequest =
    input.kind === "send"
      ? {
          conversationId,
          kind: "send",
          text: input.text,
          skill: skill ?? undefined,
          attachmentIds: input.attachmentIds,
          steer: input.steer,
          projectId: input.projectId,
        }
      : { conversationId, ...input };
  return { deps, request };
}

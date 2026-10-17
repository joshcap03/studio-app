import { getAgentAdapter } from "@/lib/agent";
import { agentFilesForRun, runFiles } from "@/lib/agent-files";
import { readAttachment } from "@/lib/attachments";
import { storeFor } from "@/lib/chat/store-for";
import type { AgentAttachment } from "@/lib/agent/types";
import { TurnError, type TurnDeps, type TurnRequest } from "@/lib/chat/turn";
import { getConfig } from "@/lib/config";
import { previewEnabled } from "@/lib/flags";
import { memoryEnabled, recallQuery, remember } from "@/lib/memory";
import { projectForRun } from "@/lib/projects";
import { notificationFor, notify, pushEnabled } from "@/lib/push";
import { getSkill } from "@/lib/skills";
import { getTask } from "@/lib/tasks";
import { savePlanFromAgent, saveRecordFromAgent } from "@/lib/tasks/agent";
import type { Tenant } from "@/lib/tenant-core";
import type { ChatMessage, ConversationSummary, MessageOrigin } from "@/lib/types";
import { buildAgentContext, claimRun } from "@/lib/workspace";

// Builds everything one turn needs for one member, from their tenant alone: the chat route
// and a background worker run turns the same way. Nothing here touches the request, so it
// stays free of Next.js; keeping the process alive until the run settles is the caller's job.

/** What the member asked for. Skills and projects are named by id and loaded from their workspace. */
export type RunInput =
  | { kind: "send"; text: string; skillId?: string; attachmentIds?: string[]; steer?: boolean; projectId?: string }
  | { kind: "retry" }
  | { kind: "edit"; messageId: string; text: string }
  | { kind: "decide"; approvalId: string; decision: "approve" | "reject" }
  /** Run one of the member's tasks: its brief (and skill) is sent as a message no one typed. */
  | { kind: "task"; taskId: string; runId: string | null };

export interface RunOptions {
  conversationId: string;
  input: RunInput;
  /** Called after the reply's final state is saved and any notification is sent. */
  onFinished?: NonNullable<TurnDeps["onFinished"]>;
  /** Asked while the run streams; resolving true stops it (a stop requested from another process). */
  shouldStop?: TurnDeps["shouldStop"];
}

/**
 * The deps and request for `startTurn`. Throws a TurnError (404) when the skill or project
 * isn't one of the member's.
 */
export async function buildTurnDeps(
  tenant: Tenant,
  { conversationId, input: asked, onFinished, shouldStop }: RunOptions,
): Promise<{ deps: TurnDeps; request: TurnRequest }> {
  // A task's run is a message with the task's brief and skill, labeled with where it came from.
  let origin: MessageOrigin | undefined;
  let input: Exclude<RunInput, { kind: "task" }>;
  if (asked.kind === "task") {
    const task = await getTask(tenant, asked.taskId);
    if (!task) throw new TurnError(404, "Task not found.");
    origin = { kind: "task", taskId: task.id, title: task.title, runId: asked.runId };
    input = { kind: "send", text: task.instructions.trim() || task.title, skillId: task.skillId ?? undefined };
  } else {
    input = asked;
  }
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
  const [skill, project, agentFiles] = await Promise.all([
    input.kind === "send" && input.skillId ? loadSkill(input.skillId) : Promise.resolve(undefined),
    loadProject(),
    agentFilesForRun(tenant, adapter.capabilities.attachments),
  ]);
  if (skill === null) throw new TurnError(404, "Skill not found.");
  if (project === null) throw new TurnError(404, "Project not found.");
  // Every run gets the member's files for this agent, then the project's, within the cap; the
  // context names only the files that were actually sent.
  const files = runFiles(agentFiles, project?.files ?? []);
  const sent = new Set(files.map((f) => f.id));
  const named = (list: AgentAttachment[]) => list.filter((f) => sent.has(f.id)).map((f) => f.name);

  // A member who wasn't watching when the run ended gets a notification.
  const finished: NonNullable<TurnDeps["onFinished"]> = async (message, conversation, info) => {
    try {
      const notification = info.watched || !pushEnabled() ? null : notificationFor(message, conversation, info.report);
      if (notification) await notify(tenant, notification);
    } finally {
      await onFinished?.(message, conversation, info);
    }
  };

  const deps: TurnDeps = {
    store,
    adapter,
    context: {
      ...(await context),
      agentFiles: named(agentFiles),
      project: project ? { ...project.context, files: named(project.files) } : null,
    },
    projectFiles: files,
    remember: memoryEnabled() ? async (content, scope, options) => (await remember(tenant, content, scope, options)).id : undefined,
    idleTimeoutMs: getConfig().agent.idleTimeoutMs,
    // Checks the limits and records the run in one step, so a burst can't slip under them.
    claim: (replyId) => claimRun(tenant, replyId, asked.kind === "task" ? "task_run" : "agent_run"),
    timelines: previewEnabled(tenant, "why"),
    loadAttachment: (attachment) => readAttachment(tenant, attachment),
    loadSkill,
    // Plans save only in a task's conversation or the agent's setup interview (for everyone).
    savePlan: (plan: unknown) => savePlanFromAgent(tenant, conversationId, plan),
    saveRecord: (record: unknown, source: { messageId: string }) => saveRecordFromAgent(tenant, conversationId, record, source),
    onFinished: finished,
    shouldStop,
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
          origin,
        }
      : { conversationId, ...input };
  return { deps, request };
}

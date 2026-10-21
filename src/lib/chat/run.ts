import { getAgentAdapter } from "@/lib/agent";
import { agentFilesForRun, runFiles } from "@/lib/agent-files";
import { readAttachment } from "@/lib/attachments";
import { modalityOf, originFor } from "@/lib/chat/modality";
import { storeFor } from "@/lib/chat/store-for";
import type { AgentAttachment } from "@/lib/agent/types";
import { TurnError, type TurnDeps, type TurnRequest } from "@/lib/chat/turn";
import { getCompanion, refreshCompanion } from "@/lib/companion";
import { getConfig } from "@/lib/config";
import { previewEnabled } from "@/lib/flags";
import { fileArtifact } from "@/lib/library";
import { memoryEnabled, recallQuery, rememberReplacing } from "@/lib/memory";
import { resolveMergeProposal } from "@/lib/memory-merge";
import { projectForRun } from "@/lib/projects";
import { notificationFor, notify, pushEnabled } from "@/lib/push";
import { getSkill } from "@/lib/skills";
import { SETUP_SKILL_ID } from "@/lib/skills/setup";
import { getTask } from "@/lib/tasks";
import { savePlanFromAgent, saveRecordFromAgent } from "@/lib/tasks/agent";
import { saveBrowserSession } from "@/lib/browser-view";
import type { Tenant } from "@/lib/tenant-core";
import type { ChatMessage, ConversationSummary, MessageOrigin, Modality } from "@/lib/types";
import { callEnded, callForWords } from "@/lib/voice/calls";
import { resolvePersona } from "@/lib/voice/persona";
import { checkSpokenDecision } from "@/lib/voice/approvals";
import { voiceStatus } from "@/lib/voice/status";
import { buildAgentContext, claimRun, getSettings } from "@/lib/workspace";

// Builds everything one turn needs for one member, from their tenant alone: the chat route
// and a background worker run turns the same way. Nothing here touches the request, so it
// stays free of Next.js; keeping the process alive until the run settles is the caller's job.

/**
 * What the member asked for. Skills and projects are named by id and loaded from their workspace.
 * `voiceSessionId`: the call words said on a call were said on, which counts only once it's
 * checked to be the member's own. `offers`: the page the reply streams to can show the agent's
 * offer to call (one from before offers can't); `secrets`, its requests for a login or card. A decision `via` voice carries what the member was
 * heard to say and their call, and stands only once checked (src/lib/voice/approvals.ts).
 */
export type RunInput = (
  | { kind: "send"; text: string; skillId?: string; attachmentIds?: string[]; steer?: boolean; projectId?: string; modality?: Modality; voiceSessionId?: string }
  | { kind: "retry" }
  | { kind: "edit"; messageId: string; text: string }
  | { kind: "decide"; approvalId: string; decision: "approve" | "reject"; via?: "tap" | "voice"; heard?: string; voiceSessionId?: string }
) & { offers?: boolean; secrets?: boolean }
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
    // Words said on a call, or held as a voice message, are labeled as spoken; words said on a
    // call carry the call, once it's known to be the member's own (for its recap).
    if (asked.kind === "send") {
      const call = asked.modality === "call" && asked.voiceSessionId && asked.text.trim() ? await callForWords(tenant, asked.voiceSessionId).catch(() => null) : null;
      origin = originFor(asked.modality, asked.text, call?.id);
    }
  }
  // A run started with the setup skill is the setup interview's, from its context to its first plan.
  const setupRun = input.kind === "send" && input.skillId === SETUP_SKILL_ID;
  const store = storeFor(tenant);
  const earlier = store.listMessages(conversationId).catch(() => null);
  // A new message says how it was sent. A retry, an edit, or a decision answers the member's
  // latest message again, so it's said the way that one was (spoken on a call, or a voice
  // message), whatever the browser sends.
  const modality: Modality | undefined =
    input.kind === "send" ? input.modality : modalityOf((await earlier)?.findLast((m) => m.role === "user")?.origin);
  // The agent may offer a call where the member could take one: they have calls, they aren't on
  // one, they haven't said Not now to an offer here, and the page the reply streams to can show
  // the offer. A task's run streams to no page; a page that predates offers loads it without them.
  const shown = asked.kind === "task" || asked.offers === true;
  const offerCalls = shown && Boolean(voiceStatus(tenant)) && modality !== "call" && !(await earlier)?.some(declinedOffer);
  // Context (settings and memory recall) loads alongside the skill and project lookups rather
  // than after them; it only reads, so a refused run just discards it.
  // Memory is searched with the member's recent messages, not just this one, so a follow-up
  // recalls what the conversation is about rather than only the business's standing facts.
  const context = earlier
    .then((messages) => {
      if (!messages) return "text" in input ? [input.text] : [];
      const end = input.kind === "edit" ? messages.findIndex((m) => m.id === input.messageId) : -1;
      const asks = (end < 0 ? messages : messages.slice(0, end)).filter((m) => m.role === "user").map((m) => m.content);
      return "text" in input ? [...asks, input.text] : asks;
    })
    .then((asks) => buildAgentContext(tenant, recallQuery(asks), conversationId, modality, { setupRun }));
  context.catch(() => undefined);
  const adapter = getAgentAdapter();
  const loadSkill = (id: string) => getSkill(tenant, id, { call: modality === "call" });
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

  // A member who wasn't watching when the run ended gets a notification, from the agent by
  // name once it has one (with voice, the name its calls go by). Each chat run also moves its
  // companion along (best-effort).
  const companion = previewEnabled(tenant, "companion");
  const finished: NonNullable<TurnDeps["onFinished"]> = async (message, conversation, info) => {
    try {
      const self = companion
        ? await (asked.kind === "task" ? getCompanion(tenant) : getSettings(tenant).then((s) => refreshCompanion(tenant, s.setup))).catch((error) => {
            console.error("[companion] refresh failed", error);
            return null;
          })
        : null;
      const notifying = !info.watched && pushEnabled();
      const from =
        notifying && voiceStatus(tenant)
          ? await resolvePersona(tenant, self ? { companion: self } : {}).then(
              (p) => p.name,
              () => self?.name,
            )
          : self?.name;
      const notification = notifying ? notificationFor(message, conversation, info.report, from) : null;
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
      ...(offerCalls ? { calls: true } : {}),
    },
    projectFiles: files,
    remember: memoryEnabled()
      ? async (content, scope, options) => {
          const { memory, replaced } = await rememberReplacing(tenant, content, scope, options);
          return { id: memory.id, replaced };
        }
      : undefined,
    resolveMerge: memoryEnabled() ? (raw) => resolveMergeProposal(tenant, raw) : undefined,
    idleTimeoutMs: getConfig().agent.idleTimeoutMs,
    // Checks the limits and records the run in one step, so a burst can't slip under them.
    claim: (replyId) => claimRun(tenant, replyId, asked.kind === "task" ? "task_run" : "agent_run"),
    allowSpokenDecision: (approval, decision, spoken) => checkSpokenDecision(tenant, approval, decision, spoken),
    timelines: previewEnabled(tenant, "why"),
    // Replies to a voice message, and a task run's news, come back as voice notes for members with speech.
    voiceNotes: Boolean(voiceStatus(tenant)?.speech.tts),
    // A reply to words said on a call the member has since hung up on comes back as a voice note.
    callEnded: (callId) => callEnded(tenant, callId),
    offerCalls,
    offersShown: shown,
    secretsShown: asked.kind === "task" || asked.secrets === true,
    loadAttachment: (attachment) => readAttachment(tenant, attachment),
    loadSkill,
    // A plan saves where the work here keeps it: the conversation's task, the owner's setup
    // checklist (a run started with the setup skill is the setup's from its first save), or the
    // conversation itself.
    savePlan: (plan: unknown, goal: unknown) =>
      savePlanFromAgent(tenant, conversationId, plan, goal, { setup: setupRun }),
    saveRecord: (record: unknown, source: { messageId: string }) => saveRecordFromAgent(tenant, conversationId, record, source),
    saveBrowserSession: (sessionId: string | null) => saveBrowserSession(tenant, conversationId, sessionId),
    fileArtifact: (artifact, source) => fileArtifact(tenant, artifact, { conversationId, messageId: source.messageId }),
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
      : input.kind === "decide"
        ? {
            conversationId,
            kind: "decide",
            approvalId: input.approvalId,
            decision: input.decision,
            // Said, not tapped: checked as said even with words or a call missing (and refused then).
            ...(input.via === "voice" ? { spoken: { heard: input.heard ?? "", voiceSessionId: input.voiceSessionId ?? "" } } : {}),
          }
        : { conversationId, ...input };
  return { deps, request };
}

/** Whether the member said Not now to an offer to call under this message. */
function declinedOffer(message: ChatMessage): boolean {
  return Object.values(message.uiResponse ?? {}).some((r) => r.status === "declined");
}

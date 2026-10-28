import { getAgentAdapter } from "@/lib/agent";
import { agentFilesForRun, runFiles } from "@/lib/agent-files";
import { readAttachment } from "@/lib/attachments";
import { modalityOf, originFor } from "@/lib/chat/modality";
import { storeFor } from "@/lib/chat/store-for";
import type { AgentAttachment } from "@/lib/agent/types";
import { TurnError, startTurn, type TurnDeps, type TurnRequest } from "@/lib/chat/turn";
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
import { getRun, getTask, getTaskForConversation, settleKeptRun, settleWaitingRun } from "@/lib/tasks";
import type { AgentTask } from "@/lib/tasks/types";
import { getAllowedActions, setAllowedAction } from "@/lib/account";
import { siteOf, type StandingKind } from "@/lib/approvals/standing";
import { savePlanFromAgent, saveRecordFromAgent } from "@/lib/tasks/agent";
import { eventsCause, eventsMessage, getWatch } from "@/lib/tasks/watches";
import { appName } from "@/lib/integrations/composio";
import { browserContextFor } from "@/lib/browser-signins";
import { saveBrowserFile } from "@/lib/browser-files";
import { browserSite } from "@/lib/browser-fill";
import { saveBrowserSession } from "@/lib/browser-view";
import type { Tenant } from "@/lib/tenant-core";
import type { AgentTenantContext } from "@/lib/agent/types";
import type { ChatMessage, ConversationSummary, MessageOrigin, Modality, ScreenRef } from "@/lib/types";
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
 * offer to call (one from before offers can't); `secrets`, its requests for a login or card; `handoffs`,
 * its browser handed over. A decision `via` voice carries what the member was
 * heard to say and their call, and stands only once checked (src/lib/voice/approvals.ts).
 * `screen`: the page they were looking at as they spoke on a call, by id.
 */
export type RunInput = (
  | { kind: "send"; text: string; skillId?: string; attachmentIds?: string[]; steer?: boolean; projectId?: string; modality?: Modality; voiceSessionId?: string; screen?: ScreenRef }
  | { kind: "retry" }
  /** Carry on the job the latest reply said wasn't finished (keep_going). */
  | { kind: "continue" }
  | { kind: "edit"; messageId: string; text: string }
  | {
      kind: "decide";
      approvalId: string;
      decision: "approve" | "reject";
      via?: "tap" | "voice";
      heard?: string;
      voiceSessionId?: string;
      /** "grant": approve, and don't ask again for its kind; "auto": the run itself, under that OK. */
      standing?: "grant" | "auto";
    }
) & { offers?: boolean; secrets?: boolean; handoffs?: boolean }
  /** Run one of the member's tasks: its brief (and skill) is sent as a message no one typed. */
  | { kind: "task"; taskId: string; runId: string | null };

export interface RunOptions {
  conversationId: string;
  input: RunInput;
  /** Called after the reply's final state is saved and any notification is sent. */
  onFinished?: NonNullable<TurnDeps["onFinished"]>;
  /** Asked while the run streams; resolving true stops it (a stop requested from another process). */
  shouldStop?: TurnDeps["shouldStop"];
  /**
   * Asked first when the reply's final state is saved: whether something carries the run on at
   * once (a task's run approving a request under the member's standing OK). True skips the
   * notification and onFinished; the run carried on reports instead. Without it, a request the
   * member's standing OK covers is approved and carried on here (standingCarryOn).
   */
  carryOn?: (message: ChatMessage) => Promise<boolean>;
  /** How many more requests this run may approve itself under a standing OK (MAX_STANDING to start). */
  standingLeft?: number;
  /**
   * When the request running this turn must stop (epoch ms). A run carried on in the same request
   * keeps the one it started with; a new request gets its own.
   */
  deadline?: number;
}

/** Requests one run approves itself under the member's standing OK before it waits on them anyway. */
export const MAX_STANDING = 20;

/**
 * The kinds of change the member has OK'd for good that cover a run here
 * (src/lib/approvals/standing.ts): their own, for any of their agents, and the conversation's
 * task's, from before those were the person's. Read fresh; none when they can't be read.
 */
export async function allowedHere(tenant: Tenant, task: Pick<AgentTask, "allowedActions"> | null): Promise<StandingKind[]> {
  const own = await getAllowedActions(tenant).catch((error) => {
    console.error("[run] couldn't read standing OKs", error);
    return [] as StandingKind[];
  });
  return [...new Set([...own, ...(task?.allowedActions ?? [])])];
}

/**
 * How long one request that runs a turn may live: the routes' `maxDuration` (300 seconds, the
 * most Vercel's Hobby plan allows). Raise both together.
 */
export const REQUEST_LIMIT_MS = 300_000;
/** Kept back at the end of the request to save the reply and say it ran out of time. */
export const SAVE_MARGIN_MS = 20_000;
/** A run isn't carried on under a standing OK with less of its request left than this: the member answers it. */
const MIN_CARRY_MS = 60_000;

/**
 * The deps and request for `startTurn`. Throws a TurnError (404) when the skill or project
 * isn't one of the member's.
 */
export async function buildTurnDeps(
  tenant: Tenant,
  { conversationId, input: asked, onFinished, shouldStop, carryOn, standingLeft = MAX_STANDING, deadline = Date.now() + REQUEST_LIMIT_MS - SAVE_MARGIN_MS }: RunOptions,
): Promise<{ deps: TurnDeps; request: TurnRequest }> {
  // Whether the member has voice: without it nothing about the run is spoken, whatever the
  // browser sends or an older message from when it was on says.
  const voiceOn = Boolean(voiceStatus(tenant));
  // A task's run is a message with the task's brief and skill, labeled with where it came from.
  let origin: MessageOrigin | undefined;
  let input: Exclude<RunInput, { kind: "task" }>;
  // A watch's run carries what happened in the member's app, written by other people.
  let watchRun = false;
  if (asked.kind === "task") {
    const [task, run] = await Promise.all([getTask(tenant, asked.taskId), asked.runId ? getRun(tenant, asked.runId) : null]);
    if (!task) throw new TurnError(404, "Task not found.");
    const brief = task.instructions.trim() || task.title;
    const events = run?.taskId === task.id && run.events?.length ? run.events : null;
    const cause = events && eventsCause(events, run!.moreEvents);
    origin = { kind: "task", taskId: task.id, title: task.title, runId: asked.runId, ...(cause ? { cause } : {}) };
    let text = brief;
    if (events) {
      watchRun = true;
      const watch = await getWatch(tenant, task.id);
      text = eventsMessage(brief, watch ? appName(watch.toolkit) : "a connected app", events, run!.moreEvents);
    }
    input = { kind: "send", text, skillId: task.skillId ?? undefined };
  } else {
    input = asked;
    // Words said on a call, or held as a voice message, are labeled as spoken; words said on a
    // call carry the call, once it's known to be the member's own (for its recap). Without voice
    // everything is typed.
    if (asked.kind === "send" && voiceOn) {
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
  const modality: Modality | undefined = !voiceOn
    ? undefined
    : input.kind === "send"
      ? input.modality
      : modalityOf((await earlier)?.findLast((m) => m.role === "user")?.origin);
  // A retry, a decision, or carrying on continues a watch's run under the same rules.
  if (asked.kind === "retry" || asked.kind === "decide" || asked.kind === "continue") {
    const answered = (await earlier)?.findLast((m) => m.role === "user")?.origin;
    watchRun = answered?.kind === "task" && Boolean(answered.cause);
  }
  // The agent may offer a call where the member could take one: they have calls, they aren't on
  // one, they haven't said Not now to an offer here, and the page the reply streams to can show
  // the offer. A task's run streams to no page; a page that predates offers loads it without them.
  const shown = asked.kind === "task" || asked.offers === true;
  const offerCalls = shown && voiceOn && modality !== "call" && !(await earlier)?.some(declinedOffer);
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
  const [skill, project, agentFiles, browserContext, screen, task] = await Promise.all([
    input.kind === "send" && input.skillId ? loadSkill(input.skillId) : Promise.resolve(undefined),
    loadProject(),
    agentFilesForRun(tenant, adapter.capabilities.attachments),
    // The person's saved sign-ins for the agent's browser; without them it opens signed out.
    browserContextFor(tenant).catch((error) => {
      console.error("[browser] couldn't load saved sign-ins:", error instanceof Error ? error.message : error);
      return null;
    }),
    input.kind === "send" && input.screen && voiceOn ? onScreen(tenant, input.screen).catch(() => null) : Promise.resolve(null),
    // In a task's conversation, the task, with the member's standing OKs on it from before.
    getTaskForConversation(tenant, conversationId).catch(() => null),
  ]);
  // A watch's run reads other people's words, so only the older tidy kinds cover it there, never
  // a payment the member OK'd elsewhere.
  const allowed = (await allowedHere(tenant, task)).filter((k) => !watchRun || k === "gmail_labels");
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
  // Anywhere else (a chat, or the member answering a task's request), a request their standing OK
  // covers is approved here and the run carries on, as a task's run does (src/lib/tasks/run-task.ts).
  const carry =
    carryOn ??
    ((message: ChatMessage) =>
      standingCarryOn(tenant, conversationId, message, {
        onFinished,
        shouldStop,
        standingLeft,
        deadline,
        pages: asked.kind === "task" ? {} : { offers: asked.offers, secrets: asked.secrets, handoffs: asked.handoffs },
      }));
  const finished: NonNullable<TurnDeps["onFinished"]> = async (message, conversation, info) => {
    const carried = await carry(message).catch((error) => {
      console.error("[run] couldn't carry the run on", error);
      return false;
    });
    if (carried) return;
    try {
      const self = companion
        ? await (asked.kind === "task" ? getCompanion(tenant) : getSettings(tenant).then((s) => refreshCompanion(tenant, s.setup))).catch((error) => {
            console.error("[companion] refresh failed", error);
            return null;
          })
        : null;
      // A task's reply that carries on in the next one says nothing yet: the last one does.
      const notifying = !info.watched && pushEnabled() && !(task && message.keepGoing);
      const from =
        notifying && voiceStatus(tenant)
          ? await resolvePersona(tenant, self ? { companion: self } : {}).then(
              (p) => p.name,
              () => self?.name,
            )
          : self?.name;
      const notification = notifying ? notificationFor(message, conversation, info.report, from) : null;
      if (notification) await notify(tenant, notification);
      // The member answered a task's run's request here: the run it continues is over, or waits again.
      if (task && asked.kind === "decide" && !carryOn) {
        await settleWaitingRun(tenant, task.id, message, info.report).catch((e) => console.error("[tasks] couldn't record the run's outcome", e));
      }
      // The member's page carried a task's run on: that run goes on, or ends, with this reply.
      if (task && asked.kind === "continue" && !carryOn) {
        await settleKeptRun(tenant, task.id, message, info.report).catch((e) => console.error("[tasks] couldn't record the run's outcome", e));
      }
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
      ...(browserContext ? { browserContext } : {}),
      ...(screen ? { screen } : {}),
      ...(allowed.length ? { allowed } : {}),
      ...(watchRun ? { runCause: "watch" as const } : {}),
    },
    projectFiles: files,
    remember: memoryEnabled()
      ? async (content, scope, options) => {
          // Other people's words started a watch's run: what it learns goes to this agent's shared
          // memory, where the reply's Undo and the Brain show it, never the person's own.
          const { memory, replaced } = await rememberReplacing(tenant, content, watchRun ? "workspace" : scope, options);
          return { id: memory.id, replaced };
        }
      : undefined,
    resolveMerge: memoryEnabled() ? (raw) => resolveMergeProposal(tenant, raw) : undefined,
    idleTimeoutMs: getConfig().agent.idleTimeoutMs,
    deadline,
    // Checks the limits and records the run in one step, so a burst can't slip under them.
    claim: (replyId) => claimRun(tenant, replyId, asked.kind === "task" ? "task_run" : "agent_run"),
    allowSpokenDecision: (approval, decision, spoken) => checkSpokenDecision(tenant, approval, decision, spoken),
    // The member's standing OKs (src/lib/approvals/standing.ts), and how their first approval of a
    // kind adds one: to the person, so every chat and task of every agent of theirs stops asking.
    // A browser step's kind is the site the conversation's browser is on, read from the browser.
    standing: {
      allowed,
      grant: async (kind: StandingKind) => (await setAllowedAction(tenant, kind, true)).includes(kind),
      site: async () => {
        const found = await browserSite(tenant, conversationId).catch(() => null);
        return found?.ok ? siteOf(found.site) : null;
      },
      tidyOnly: watchRun,
    },
    timelines: previewEnabled(tenant, "why"),
    // Replies to a voice message, and a task run's news, come back as voice notes for members with speech.
    voiceNotes: Boolean(voiceStatus(tenant)?.speech.tts),
    // A reply to words said on a call the member has since hung up on comes back as a voice note.
    callEnded: (callId) => callEnded(tenant, callId),
    offerCalls,
    // Without voice, an offer from when it was on never shows again (on a reply continued after an approval).
    offersShown: shown && voiceOn,
    voice: voiceOn,
    secretsShown: asked.kind === "task" || asked.secrets === true,
    // The member can take over the agent's browser wherever the app can reach it.
    handoffs: Boolean(getConfig().browser),
    handoffsShown: asked.kind === "task" || asked.handoffs === true,
    loadAttachment: (attachment) => readAttachment(tenant, attachment),
    loadSkill,
    // A plan saves where the work here keeps it: the conversation's task, the owner's setup
    // checklist (a run started with the setup skill is the setup's from its first save), or the
    // conversation itself.
    savePlan: (plan: unknown, goal: unknown) =>
      savePlanFromAgent(tenant, conversationId, plan, goal, { setup: setupRun }),
    saveRecord: (record: unknown, source: { messageId: string }) => saveRecordFromAgent(tenant, conversationId, record, source),
    saveBrowserSession: (sessionId: string | null) => saveBrowserSession(tenant, conversationId, sessionId),
    // A file from the conversation's browser, saved on the reply that asked for it.
    saveBrowserFile: (file: unknown, source: { messageId: string }) => saveBrowserFile(tenant, conversationId, source.messageId, file),
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
            ...(input.standing ? { standing: input.standing } : {}),
          }
        : { conversationId, ...input };
  return { deps, request };
}

/**
 * The conversation's messages with its pending request marked `auto` when the member's standing
 * OK covers it: the run is approving it itself, so their page follows the run rather than asking.
 */
export async function markCovered(tenant: Tenant, conversationId: string, messages: ChatMessage[]): Promise<ChatMessage[]> {
  const last = messages.at(-1);
  const pending = last?.status === "awaiting" ? last.approvals?.find((a) => a.status === "pending" && a.standing) : undefined;
  if (!last || !pending?.standing) return messages;
  const allowed = await allowedHere(tenant, await getTaskForConversation(tenant, conversationId).catch(() => null));
  if (!allowed.includes(pending.standing)) return messages;
  const approvals = last.approvals!.map((a) => (a.id === pending.id ? { ...a, auto: true as const } : a));
  return [...messages.slice(0, -1), { ...last, approvals }];
}

/**
 * When a reply ends waiting on a request the member's standing OK covers, approves it as the run
 * (recorded as decided_via 'standing') and carries the run on in a turn of its own, which the
 * member's page follows. Resolves whether it did. The OK is read fresh, so one taken back stops
 * the next request; at most `standingLeft` more in a row, and only with time left in the request.
 */
export async function standingCarryOn(
  tenant: Tenant,
  conversationId: string,
  message: ChatMessage,
  options: Pick<RunOptions, "onFinished" | "shouldStop" | "carryOn"> & {
    standingLeft: number;
    /** The deadline of the request this runs in, which the run carried on keeps. */
    deadline: number;
    pages?: { offers?: boolean; secrets?: boolean; handoffs?: boolean };
    task?: Pick<AgentTask, "allowedActions"> | null;
  },
): Promise<boolean> {
  if (message.status !== "awaiting" || options.standingLeft <= 0 || options.deadline - Date.now() < MIN_CARRY_MS) return false;
  const [pending, task] = await Promise.all([
    storeFor(tenant).pendingApproval(conversationId),
    options.task !== undefined ? options.task : getTaskForConversation(tenant, conversationId).catch(() => null),
  ]);
  if (!pending?.standing || pending.messageId !== message.id) return false;
  if (!(await allowedHere(tenant, task)).includes(pending.standing)) return false;
  const next = await buildTurnDeps(tenant, {
    conversationId,
    input: { kind: "decide", approvalId: pending.id, decision: "approve", standing: "auto", ...options.pages },
    onFinished: options.onFinished,
    shouldStop: options.shouldStop,
    carryOn: options.carryOn,
    standingLeft: options.standingLeft - 1,
    deadline: options.deadline,
  });
  // No one reads this stream: the member's page follows the reply from its saved state.
  void (await startTurn(next.deps, next.request)).cancel();
  return true;
}

/** Whether the member said Not now to an offer to call under this message. */
function declinedOffer(message: ChatMessage): boolean {
  return Object.values(message.uiResponse ?? {}).some((r) => r.status === "declined");
}

/**
 * What the member was looking at, loaded by id under their session: a task that isn't theirs is
 * nothing. A tracker is named from its collection, the way the Library shows it.
 */
async function onScreen(tenant: Tenant, screen: ScreenRef): Promise<AgentTenantContext["screen"] | null> {
  if (screen.kind === "tracker") {
    const words = screen.collection.replace(/[-_]+/g, " ").trim();
    return { kind: "tracker", name: words.charAt(0).toUpperCase() + words.slice(1) };
  }
  const task = await getTask(tenant, screen.id);
  return task ? { kind: "task", title: task.title, status: task.status } : null;
}

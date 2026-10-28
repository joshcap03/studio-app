import type { Ask, LastMessage } from "@/lib/chat/move";
import { fitTools } from "@/lib/approvals/spoken";
import { isStandingKind } from "@/lib/approvals/standing";
import type { Db } from "@/lib/supabase/db";
import type { PlanStep } from "@/lib/tasks/types";
import type {
  ActivityStep,
  Approval,
  Artifact,
  Attachment,
  ChatMessage,
  ConversationSummary,
  MemoryProposal,
  MessageFeedback,
  MessageOrigin,
  MessageSkill,
  MessageStatus,
  Question,
  TapOnlyReason,
  UiBlock,
  UiResponse,
  Citation,
  Timeline,
  VoiceNote,
} from "@/lib/types";

// The conversation persistence boundary, scoped to one tenant (workspace + user). Every
// query carries both ids explicitly, and Row Level Security enforces the same scope in the
// database, so a forged id in a URL or body can never reach another tenant's rows.

export interface Scope {
  workspaceId: string;
  userId: string;
}

export interface Conversation extends ConversationSummary {
  agentProvider: string | null;
  agentThreadId: string | null;
}

export interface MessagePatch {
  content?: string;
  status?: MessageStatus;
  activity?: ActivityStep[];
  artifacts?: Artifact[];
  memoryProposals?: MemoryProposal[];
  timeline?: Timeline | null;
  citations?: Citation[] | null;
  questions?: Question[] | null;
  ui?: UiBlock[] | null;
  uiResponse?: Record<string, UiResponse> | null;
  voiceNote?: VoiceNote | null;
  keepGoing?: string | null;
  error?: string | null;
}

/** An approval as the server sees it: with what the provider needs to continue the run. */
export interface StoredApproval extends Approval {
  conversationId: string;
  messageId: string;
  provider: string;
  providerState: unknown;
  /** What approving it runs, by the provider's names for the tools (for looking into a report). */
  tools?: string[];
}

export type NewApproval = Omit<StoredApproval, "id" | "status" | "createdAt" | "decidedAt" | "decidedVia" | "decidedWords" | "reported">;

/** How a decision was made: by hand (`tap`), or by the member's spoken `words`. */
/**
 * How a decision was made: a tap (or typed words), or said on a call, with the member's words
 * and the call they were said on (the database checks it's their own open call).
 */
export type ApprovalDecision = { via: "tap" } | { via: "voice"; words: string; call: string } | { via: "standing" };

/** An attachment with where its bytes live. Server-side only. */
export interface StoredAttachment extends Attachment {
  storagePath: string;
}

/**
 * A conversation's own plan (one that isn't a task's or the setup's), as the agent last saved it:
 * its steps, what done looks like, and when it changed (null before it ever had one).
 */
export interface ConversationPlan {
  steps: PlanStep[];
  goal: string | null;
  updatedAt: number | null;
}

/**
 * A message with only what starting a turn needs: who said what, how, and whether it waits to be
 * carried on. No steps, cards, files, or sources: the whole list is read before every turn.
 */
export type RunMessage = Pick<ChatMessage, "id" | "conversationId" | "role" | "content" | "status" | "origin" | "skill" | "uiResponse" | "keepGoing" | "createdAt">;

export interface Store {
  readonly scope: Scope;
  listConversations(query?: string): Promise<ConversationSummary[]>;
  /** The conversations in one project (searching covers every conversation). */
  listProjectConversations(projectId: string): Promise<ConversationSummary[]>;
  /** Titles of the caller's conversations active since `since` (ms), newest first, leaving out `except`. */
  recentTitles(since: number, limit: number, except?: string): Promise<string[]>;
  getConversation(id: string): Promise<Conversation | null>;
  createConversation(input: { id: string; title: string; projectId?: string | null }): Promise<Conversation>;
  renameConversation(id: string, title: string): Promise<ConversationSummary | null>;
  /** Moves a conversation into a project of the caller's, or out of any (null). */
  moveConversation(id: string, projectId: string | null): Promise<ConversationSummary | null>;
  deleteConversation(id: string): Promise<boolean>;
  /** Ids of every one of the caller's conversations in the workspace. */
  conversationIds(): Promise<string[]>;
  /** Deletes every one of the caller's conversations in the workspace; returns their ids. */
  deleteAllConversations(): Promise<string[]>;
  setAgentThread(conversationId: string, provider: string, threadId: string): Promise<void>;
  touchConversation(conversationId: string): Promise<ConversationSummary>;
  /** The conversation's own plan, or null when there's no such conversation. */
  getPlan(conversationId: string): Promise<ConversationPlan | null>;
  /** Replaces the conversation's plan and goal; null when there's no such conversation. */
  savePlan(conversationId: string, plan: { steps: PlanStep[]; goal: string | null }): Promise<ConversationPlan | null>;
  /**
   * The latest message in each of these conversations, as far as whose move it is, by
   * conversation id. Ids that aren't the caller's, or have no messages, are left out.
   */
  lastMessages(conversationIds: string[]): Promise<Record<string, LastMessage>>;
  listMessages(conversationId: string): Promise<ChatMessage[]>;
  /**
   * The newest `limit` messages, oldest first, and whether there are earlier ones; with `before`,
   * the page before that message (none when it isn't here). Earlier pages load as the member reads back.
   */
  pageMessages(conversationId: string, page: { limit: number; before?: string }): Promise<{ messages: ChatMessage[]; earlier: boolean }>;
  /**
   * The message `fromId` as it stands now and everything after it, oldest first, for following a
   * run with little traffic; null when there's no such message in the conversation.
   */
  messagesSince(conversationId: string, fromId: string): Promise<ChatMessage[] | null>;
  /** Every message in the conversation, oldest first, with only what a turn needs (see RunMessage). */
  listMessagesForRun(conversationId: string): Promise<RunMessage[]>;
  /**
   * The conversation's latest message, as far as whether a turn may start there: its id and
   * status (one small read, for checking a list loaded a moment ago is still current).
   */
  latestMessage(conversationId: string): Promise<{ id: string; status: MessageStatus } | null>;
  /** One message of the caller's in a conversation, or null when there's no such message. */
  getMessage(conversationId: string, id: string): Promise<ChatMessage | null>;
  insertMessage(message: Omit<ChatMessage, "createdAt">): Promise<ChatMessage>;
  updateMessage(id: string, patch: MessagePatch): Promise<void>;
  /**
   * Asks the conversation's reply still streaming to stop, wherever it's running: the run checks
   * `stopRequested` every few seconds. False when nothing in the conversation is streaming.
   */
  requestStop(conversationId: string): Promise<boolean>;
  /** Whether the member asked this reply to stop since it last started streaming. */
  stopRequested(messageId: string): Promise<boolean>;
  /**
   * Takes a reply that carries a job on (keep_going) so only one next reply carries it on: the
   * member's page, the background worker, or a task's run. Without `messageId`, ends any waiting in
   * the conversation (the member's Stop). False when there was none to take (or someone else took it).
   */
  claimKeepGoing(conversationId: string, messageId?: string): Promise<boolean>;
  /** Records the member's rating of one of their replies (null clears it). False if no such reply. */
  setFeedback(conversationId: string, id: string, feedback: MessageFeedback | null): Promise<boolean>;
  /** Records the provider's trace id for the run that wrote a reply (server-side only). */
  setTrace(id: string, traceId: string): Promise<void>;
  /** A reply's current rating and trace id, for sending the rating to tracing. Null if no such reply. */
  ratedReply(conversationId: string, id: string): Promise<{ feedback: MessageFeedback | null; traceId: string | null } | null>;
  deleteMessage(id: string): Promise<void>;
  /** Deletes every message that comes after `messageId` in its conversation. */
  deleteMessagesAfter(conversationId: string, messageId: string): Promise<void>;

  createApproval(approval: NewApproval): Promise<StoredApproval>;
  getApproval(id: string): Promise<StoredApproval | null>;
  /** The conversation's undecided approval, if any. */
  pendingApproval(conversationId: string): Promise<StoredApproval | null>;
  /** Every undecided approval across the caller's conversations. */
  pendingApprovals(): Promise<StoredApproval[]>;
  /**
   * Moves an approval from one status to another; false if it wasn't in `from` (e.g. decided
   * elsewhere). `how`: the member's decision, and how they made it (absent when no one decided:
   * it expired, or writing instead declined it).
   */
  settleApproval(id: string, from: Approval["status"], to: Approval["status"], how?: ApprovalDecision): Promise<boolean>;

  /** Attaches uploaded, not-yet-sent files to a message. False unless every id was claimable. */
  claimAttachments(ids: string[], messageId: string): Promise<boolean>;
  listAttachments(messageId: string): Promise<StoredAttachment[]>;
  getAttachment(id: string): Promise<StoredAttachment | null>;
  /** Storage paths of every file attached in a conversation (for cleanup on delete). */
  attachmentPaths(conversationId: string): Promise<string[]>;
  /** Storage paths of every file attached in any of the caller's conversations. */
  allAttachmentPaths(): Promise<string[]>;
}

interface ConversationRow {
  id: string;
  title: string;
  project_id: string | null;
  agent_provider: string | null;
  agent_thread_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  activity: ActivityStep[];
  artifacts: Artifact[];
  memory_proposals: MemoryProposal[] | null;
  timeline: Timeline | null;
  citations: Citation[] | null;
  questions: Question[] | null;
  ui: UiBlock[] | null;
  ui_response: Record<string, UiResponse> | null;
  feedback: MessageFeedback | null;
  voice_note: VoiceNote | null;
  keep_going: string | null;
  continued_at: string | null;
  error: string | null;
  skill: MessageSkill | null;
  origin: MessageOrigin | null;
  created_at: string;
  updated_at: string;
  approvals?: ApprovalRow[] | null;
  attachments?: AttachmentRow[] | null;
}

interface ApprovalRow {
  id: string;
  conversation_id: string;
  message_id: string;
  summary: string;
  app: string | null;
  details: [string, string][];
  status: Approval["status"];
  provider: string;
  provider_state: unknown;
  created_at: string;
  decided_at: string | null;
  tools?: string[] | null;
  voice_ok?: boolean | null;
  tap_only?: TapOnlyReason | null;
  read_back?: string | null;
  decided_via?: "tap" | "voice" | "standing" | null;
  standing?: string | null;
  decided_words?: string | null;
  reported_at?: string | null;
}

interface AttachmentRow {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  storage_path: string;
}

interface PlanRow {
  plan: PlanStep[];
  goal: string | null;
  plan_updated_at: string | null;
}

/** What conversation_moves returns for one conversation (see its migration). */
interface MoveRow {
  conversation_id: string;
  role: "user" | "assistant";
  status: MessageStatus;
  updated_at: string;
  open_ask: string | null;
}

const ASKS: readonly Ask[] = ["approval", "form", "proposal", "merge", "browser", "question"];

/** Most conversations whose moves one call looks up. */
export const MAX_MOVES = 100;

// The plan columns stay out of the conversation list and summaries, which go to the browser
// for every conversation; only the plan's own reads and writes touch them.
const CONVERSATION_COLUMNS = "id, title, project_id, agent_provider, agent_thread_id, created_at, updated_at";
const PLAN_COLUMNS = "plan, goal, plan_updated_at";
// Embedded approvals and attachments leave out provider state and storage paths: these rows
// go to the browser.
const MESSAGE_COLUMNS =
  "id, conversation_id, role, content, status, activity, artifacts, memory_proposals, timeline, citations, questions, ui, ui_response, feedback, voice_note, keep_going, continued_at, error, skill, origin, created_at, updated_at, " +
  "approvals(id, conversation_id, message_id, summary, app, details, status, created_at, decided_at, voice_ok, tap_only, read_back, decided_via, decided_words, reported_at, standing), " +
  "attachments(id, name, mime_type, size)";
const APPROVAL_COLUMNS =
  "id, conversation_id, message_id, summary, app, details, status, provider, provider_state, created_at, decided_at, tools, voice_ok, tap_only, read_back, decided_via, decided_words, reported_at, standing";
const ATTACHMENT_COLUMNS = "id, name, mime_type, size, storage_path";
const RUN_COLUMNS = "id, conversation_id, role, content, status, origin, skill, ui_response, keep_going, continued_at, created_at, updated_at";

const toApproval = (r: Omit<ApprovalRow, "provider" | "provider_state">): Approval => ({
  id: r.id,
  summary: r.summary,
  app: r.app ?? undefined,
  details: Array.isArray(r.details) ? r.details : [],
  status: r.status,
  createdAt: Date.parse(r.created_at),
  decidedAt: r.decided_at ? Date.parse(r.decided_at) : undefined,
  // Voice-ok only with its read-back; anything else, including requests from before, is a tap.
  spoken: r.voice_ok === true && r.read_back ? { ok: true, readBack: r.read_back } : { ok: false, reason: r.tap_only ?? "unsupported" },
  ...(r.decided_via ? { decidedVia: r.decided_via } : {}),
  ...(r.decided_via === "voice" && r.decided_words ? { decidedWords: r.decided_words } : {}),
  ...(r.reported_at ? { reported: true } : {}),
  ...(isStandingKind(r.standing) ? { standing: r.standing } : {}),
});

const toStoredApproval = (r: ApprovalRow): StoredApproval => ({
  ...toApproval(r),
  conversationId: r.conversation_id,
  messageId: r.message_id,
  provider: r.provider,
  providerState: r.provider_state,
  tools: r.tools ?? [],
});

const toAttachment = (r: Omit<AttachmentRow, "storage_path">): Attachment => ({ id: r.id, name: r.name, mimeType: r.mime_type, size: r.size });

const toSummary = (r: ConversationRow): ConversationSummary => ({
  id: r.id,
  title: r.title,
  projectId: r.project_id,
  createdAt: Date.parse(r.created_at),
  updatedAt: Date.parse(r.updated_at),
});

const toConversation = (r: ConversationRow): Conversation => ({
  ...toSummary(r),
  agentProvider: r.agent_provider,
  agentThreadId: r.agent_thread_id,
});

const toPlan = (r: PlanRow): ConversationPlan => ({
  steps: Array.isArray(r.plan) ? r.plan : [],
  goal: r.goal,
  updatedAt: r.plan_updated_at ? Date.parse(r.plan_updated_at) : null,
});

/** How long a `streaming` message may go without a checkpoint before it counts as interrupted. */
export const STALE_STREAM_MS = 60_000;

/** A message's status as it really stands: one still "streaming" with no checkpoint lately was cut off. */
const liveStatus = (status: MessageStatus, updatedAt: string): MessageStatus =>
  status === "streaming" && Date.now() - Date.parse(updatedAt) > STALE_STREAM_MS ? "interrupted" : status;

const toMessage = (r: MessageRow): ChatMessage => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  content: r.content,
  status: liveStatus(r.status, r.updated_at),
  activity: r.activity ?? [],
  artifacts: r.artifacts ?? [],
  approvals: (r.approvals ?? []).map(toApproval).sort((a, b) => a.createdAt - b.createdAt),
  memoryProposals: r.memory_proposals ?? [],
  timeline: r.timeline ?? null,
  citations: r.citations ?? null,
  questions: r.questions ?? null,
  ui: r.ui ?? null,
  uiResponse: r.ui_response ?? null,
  feedback: r.feedback ?? null,
  voiceNote: r.voice_note ?? null,
  // Only while it's still waiting to be carried on: once taken (or stopped) it's history.
  ...(r.keep_going && !r.continued_at ? { keepGoing: r.keep_going } : {}),
  attachments: (r.attachments ?? []).map(toAttachment),
  error: r.error,
  skill: r.skill ? { id: String(r.skill.id), name: String(r.skill.name) } : null,
  origin: r.origin ?? null,
  createdAt: Date.parse(r.created_at),
});

type RunRow = Pick<MessageRow, "id" | "conversation_id" | "role" | "content" | "status" | "origin" | "skill" | "ui_response" | "keep_going" | "continued_at" | "created_at" | "updated_at">;

const toRunMessage = (r: RunRow): RunMessage => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  content: r.content,
  status: liveStatus(r.status, r.updated_at),
  origin: r.origin ?? null,
  skill: r.skill ? { id: String(r.skill.id), name: String(r.skill.name) } : null,
  uiResponse: r.ui_response ?? null,
  ...(r.keep_going && !r.continued_at ? { keepGoing: r.keep_going } : {}),
  createdAt: Date.parse(r.created_at),
});

function check<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(`Database error: ${result.error.message}`);
  return result.data;
}

/** Escape PostgREST filter syntax and LIKE wildcards in user search text. */
function searchPattern(query: string): string {
  const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/[,()"]/g, " ");
  return `%${escaped}%`;
}

export function createStore(db: Db, scope: Scope): Store {
  const { workspaceId, userId } = scope;
  const conversations = () => db.from("conversations");
  const messages = () => db.from("messages");
  const approvals = () => db.from("approvals");
  const attachments = () => db.from("attachments");
  /** A message's place in its conversation, or null when it isn't the caller's there. */
  const seqOf = async (conversationId: string, id: string): Promise<number | null> => {
    const row = check(
      await messages().select("seq").eq("id", id).eq("conversation_id", conversationId).eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle(),
    ) as { seq: number } | null;
    return row ? row.seq : null;
  };

  return {
    scope,

    async listConversations(query) {
      const q = query?.trim();
      if (!q) {
        const rows = check(
          await conversations()
            .select(CONVERSATION_COLUMNS)
            .eq("workspace_id", workspaceId)
            .eq("user_id", userId)
            .order("updated_at", { ascending: false })
            .limit(500),
        ) as ConversationRow[];
        return rows.map(toSummary);
      }
      const pattern = searchPattern(q);
      const [byTitle, byContent] = await Promise.all([
        conversations()
          .select(CONVERSATION_COLUMNS)
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .ilike("title", pattern)
          .limit(100),
        messages()
          .select("conversation_id")
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .ilike("content", pattern)
          .limit(200),
      ]);
      const titleRows = check(byTitle) as ConversationRow[];
      const ids = new Set((check(byContent) as { conversation_id: string }[]).map((r) => r.conversation_id));
      for (const r of titleRows) ids.delete(r.id);
      let contentRows: ConversationRow[] = [];
      if (ids.size > 0) {
        contentRows = check(
          await conversations()
            .select(CONVERSATION_COLUMNS)
            .eq("workspace_id", workspaceId)
            .eq("user_id", userId)
            .in("id", [...ids]),
        ) as ConversationRow[];
      }
      return [...titleRows, ...contentRows].map(toSummary).sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async listProjectConversations(projectId) {
      const rows = check(
        await conversations()
          .select(CONVERSATION_COLUMNS)
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .eq("project_id", projectId)
          .order("updated_at", { ascending: false })
          .limit(500),
      ) as ConversationRow[];
      return rows.map(toSummary);
    },

    async recentTitles(since, limit, except) {
      let query = conversations()
        .select("id, title")
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId)
        .gte("updated_at", new Date(since).toISOString());
      if (except) query = query.neq("id", except);
      const rows = check(await query.order("updated_at", { ascending: false }).limit(limit)) as { title: string }[];
      return rows.map((r) => r.title);
    },

    async getConversation(id) {
      const row = check(
        await conversations()
          .select(CONVERSATION_COLUMNS)
          .eq("id", id)
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .maybeSingle(),
      ) as ConversationRow | null;
      return row ? toConversation(row) : null;
    },

    async createConversation({ id, title, projectId = null }) {
      const row = check(
        await conversations()
          .insert({ id, title, project_id: projectId, workspace_id: workspaceId, user_id: userId })
          .select(CONVERSATION_COLUMNS)
          .single(),
      ) as ConversationRow;
      return toConversation(row);
    },

    async renameConversation(id, title) {
      const row = check(
        await conversations()
          .update({ title })
          .eq("id", id)
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .select(CONVERSATION_COLUMNS)
          .maybeSingle(),
      ) as ConversationRow | null;
      return row ? toSummary(row) : null;
    },

    async moveConversation(id, projectId) {
      const row = check(
        await conversations()
          .update({ project_id: projectId })
          .eq("id", id)
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .select(CONVERSATION_COLUMNS)
          .maybeSingle(),
      ) as ConversationRow | null;
      return row ? toSummary(row) : null;
    },

    async deleteConversation(id) {
      const rows = check(
        await conversations().delete().eq("id", id).eq("workspace_id", workspaceId).eq("user_id", userId).select("id"),
      ) as { id: string }[];
      return rows.length > 0;
    },

    async conversationIds() {
      const rows = check(await conversations().select("id").eq("workspace_id", workspaceId).eq("user_id", userId)) as { id: string }[];
      return rows.map((r) => r.id);
    },

    async deleteAllConversations() {
      const rows = check(
        await conversations().delete().eq("workspace_id", workspaceId).eq("user_id", userId).select("id"),
      ) as { id: string }[];
      return rows.map((r) => r.id);
    },

    async setAgentThread(conversationId, provider, threadId) {
      check(
        await conversations()
          .update({ agent_provider: provider, agent_thread_id: threadId })
          .eq("id", conversationId)
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId),
      );
    },

    async touchConversation(conversationId) {
      const row = check(
        await conversations()
          .update({ updated_at: new Date().toISOString() })
          .eq("id", conversationId)
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .select(CONVERSATION_COLUMNS)
          .single(),
      ) as ConversationRow;
      return toSummary(row);
    },

    async getPlan(conversationId) {
      const row = check(
        await conversations().select(PLAN_COLUMNS).eq("id", conversationId).eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle(),
      ) as PlanRow | null;
      return row ? toPlan(row) : null;
    },

    async savePlan(conversationId, { steps, goal }) {
      const row = check(
        await conversations()
          .update({ plan: steps, goal, plan_updated_at: new Date().toISOString() })
          .eq("id", conversationId)
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .select(PLAN_COLUMNS)
          .maybeSingle(),
      ) as PlanRow | null;
      return row ? toPlan(row) : null;
    },

    async lastMessages(conversationIds) {
      const ids = [...new Set(conversationIds)].slice(0, MAX_MOVES);
      if (ids.length === 0) return {};
      const rows = check(await db.rpc("conversation_moves", { p_workspace: workspaceId, p_ids: ids })) as MoveRow[] | null;
      return Object.fromEntries(
        (rows ?? []).map((r) => [
          r.conversation_id,
          { role: r.role, status: liveStatus(r.status, r.updated_at), ask: ASKS.find((a) => a === r.open_ask) ?? null },
        ]),
      );
    },

    async listMessages(conversationId) {
      const rows = check(
        await messages()
          .select(MESSAGE_COLUMNS)
          .eq("conversation_id", conversationId)
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .order("seq", { ascending: true }),
      ) as unknown as MessageRow[];
      return rows.map(toMessage);
    },

    async pageMessages(conversationId, { limit, before }) {
      let query = messages().select(MESSAGE_COLUMNS).eq("conversation_id", conversationId).eq("workspace_id", workspaceId).eq("user_id", userId);
      if (before) {
        const anchor = await seqOf(conversationId, before);
        if (anchor === null) return { messages: [], earlier: false };
        query = query.lt("seq", anchor);
      }
      const rows = check(await query.order("seq", { ascending: false }).limit(limit + 1)) as unknown as MessageRow[];
      return { messages: rows.slice(0, limit).reverse().map(toMessage), earlier: rows.length > limit };
    },

    async messagesSince(conversationId, fromId) {
      const anchor = await seqOf(conversationId, fromId);
      if (anchor === null) return null;
      const rows = check(
        await messages()
          .select(MESSAGE_COLUMNS)
          .eq("conversation_id", conversationId)
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .gte("seq", anchor)
          .order("seq", { ascending: true }),
      ) as unknown as MessageRow[];
      return rows.map(toMessage);
    },

    async listMessagesForRun(conversationId) {
      const rows = check(
        await messages().select(RUN_COLUMNS).eq("conversation_id", conversationId).eq("workspace_id", workspaceId).eq("user_id", userId).order("seq", { ascending: true }),
      ) as unknown as RunRow[];
      return rows.map(toRunMessage);
    },

    async latestMessage(conversationId) {
      const row = check(
        await messages()
          .select("id, status, updated_at")
          .eq("conversation_id", conversationId)
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .order("seq", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ) as { id: string; status: MessageStatus; updated_at: string } | null;
      return row ? { id: row.id, status: liveStatus(row.status, row.updated_at) } : null;
    },

    async getMessage(conversationId, id) {
      const row = check(
        await messages()
          .select(MESSAGE_COLUMNS)
          .eq("id", id)
          .eq("conversation_id", conversationId)
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .maybeSingle(),
      ) as unknown as MessageRow | null;
      return row ? toMessage(row) : null;
    },

    async insertMessage(m) {
      const row = check(
        await messages()
          .insert({
            id: m.id,
            conversation_id: m.conversationId,
            workspace_id: workspaceId,
            user_id: userId,
            role: m.role,
            content: m.content,
            status: m.status,
            activity: m.activity,
            artifacts: m.artifacts,
            memory_proposals: m.memoryProposals ?? [],
            error: m.error ?? null,
            skill: m.skill ? { id: m.skill.id, name: m.skill.name } : null,
            origin: m.origin ?? null,
          })
          .select(MESSAGE_COLUMNS)
          .single(),
      ) as unknown as MessageRow;
      return toMessage(row);
    },

    async updateMessage(id, patch) {
      const values: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (patch.content !== undefined) values.content = patch.content;
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.activity !== undefined) values.activity = patch.activity;
      if (patch.artifacts !== undefined) values.artifacts = patch.artifacts;
      if (patch.memoryProposals !== undefined) values.memory_proposals = patch.memoryProposals;
      if (patch.timeline !== undefined) values.timeline = patch.timeline;
      if (patch.citations !== undefined) values.citations = patch.citations;
      if (patch.questions !== undefined) values.questions = patch.questions;
      if (patch.ui !== undefined) values.ui = patch.ui;
      if (patch.uiResponse !== undefined) values.ui_response = patch.uiResponse;
      if (patch.voiceNote !== undefined) values.voice_note = patch.voiceNote;
      if (patch.keepGoing !== undefined) values.keep_going = patch.keepGoing;
      if (patch.error !== undefined) values.error = patch.error;
      // A reply that starts streaming again (after an approval) starts without a stop asked of it.
      if (patch.status === "streaming") values.stop_requested_at = null;
      check(await messages().update(values).eq("id", id).eq("workspace_id", workspaceId).eq("user_id", userId));
    },

    async requestStop(conversationId) {
      // Not a content change, so updated_at stays put: the run's own checkpoints keep it alive.
      const rows = check(
        await messages()
          .update({ stop_requested_at: new Date().toISOString() })
          .eq("conversation_id", conversationId)
          .eq("role", "assistant")
          .eq("status", "streaming")
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .select("id"),
      ) as { id: string }[];
      return rows.length > 0;
    },

    async claimKeepGoing(conversationId, messageId) {
      // Not a content change, so updated_at stays put.
      let query = messages()
        .update({ continued_at: new Date().toISOString() })
        .eq("conversation_id", conversationId)
        .eq("role", "assistant")
        .not("keep_going", "is", null)
        .is("continued_at", null)
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId);
      if (messageId) query = query.eq("id", messageId);
      const rows = check(await query.select("id")) as { id: string }[];
      return rows.length > 0;
    },

    async stopRequested(messageId) {
      const row = check(
        await messages().select("stop_requested_at").eq("id", messageId).eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle(),
      ) as { stop_requested_at: string | null } | null;
      return row?.stop_requested_at != null;
    },

    async setFeedback(conversationId, id, feedback) {
      // Not a content change, so updated_at stays put.
      const rows = check(
        await messages()
          .update({ feedback })
          .eq("id", id)
          .eq("conversation_id", conversationId)
          .eq("role", "assistant")
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .select("id"),
      ) as { id: string }[];
      return rows.length > 0;
    },

    async setTrace(id, traceId) {
      check(
        await messages()
          .update({ trace_id: traceId })
          .eq("id", id)
          .eq("role", "assistant")
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId),
      );
    },

    async ratedReply(conversationId, id) {
      const row = check(
        await messages()
          .select("feedback, trace_id")
          .eq("id", id)
          .eq("conversation_id", conversationId)
          .eq("role", "assistant")
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .maybeSingle(),
      ) as { feedback: MessageFeedback | null; trace_id: string | null } | null;
      return row ? { feedback: row.feedback ?? null, traceId: row.trace_id } : null;
    },

    async deleteMessage(id) {
      check(await messages().delete().eq("id", id).eq("workspace_id", workspaceId).eq("user_id", userId));
    },

    async deleteMessagesAfter(conversationId, messageId) {
      const anchor = check(
        await messages()
          .select("seq")
          .eq("id", messageId)
          .eq("conversation_id", conversationId)
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .maybeSingle(),
      ) as { seq: number } | null;
      if (!anchor) return;
      check(
        await messages()
          .delete()
          .eq("conversation_id", conversationId)
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .gt("seq", anchor.seq),
      );
    },

    async createApproval(a) {
      const row = check(
        await approvals()
          .insert({
            workspace_id: workspaceId,
            user_id: userId,
            conversation_id: a.conversationId,
            message_id: a.messageId,
            summary: a.summary,
            app: a.app ?? null,
            details: a.details,
            provider: a.provider,
            provider_state: a.providerState ?? {},
            tools: fitTools(a.tools ?? []),
            voice_ok: a.spoken?.ok === true,
            tap_only: a.spoken && !a.spoken.ok ? a.spoken.reason : null,
            read_back: a.spoken?.ok ? a.spoken.readBack : null,
            standing: a.standing ?? null,
          })
          .select(APPROVAL_COLUMNS)
          .single(),
      ) as ApprovalRow;
      return toStoredApproval(row);
    },

    async getApproval(id) {
      const row = check(
        await approvals().select(APPROVAL_COLUMNS).eq("id", id).eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle(),
      ) as ApprovalRow | null;
      return row ? toStoredApproval(row) : null;
    },

    async pendingApproval(conversationId) {
      const row = check(
        await approvals()
          .select(APPROVAL_COLUMNS)
          .eq("conversation_id", conversationId)
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .eq("status", "pending")
          .maybeSingle(),
      ) as ApprovalRow | null;
      return row ? toStoredApproval(row) : null;
    },

    async pendingApprovals() {
      const rows = check(
        await approvals().select(APPROVAL_COLUMNS).eq("workspace_id", workspaceId).eq("user_id", userId).eq("status", "pending"),
      ) as ApprovalRow[];
      return rows.map(toStoredApproval);
    },

    async settleApproval(id, from, to, how) {
      if (how?.via === "voice") {
        // Only the database records a spoken decision: on the member's own call in this agent,
        // still open, and (approving) a request classified voice-ok when it was asked.
        if (from !== "pending" || (to !== "approved" && to !== "declined")) throw new Error("A spoken decision answers a pending request.");
        return check(await db.rpc("settle_spoken_approval", { p_approval: id, p_decision: to, p_call: how.call, p_words: how.words })) === true;
      }
      const rows = check(
        await approvals()
          .update({
            status: to,
            decided_at: new Date().toISOString(),
            ...(how ? { decided_via: how.via } : {}),
          })
          .eq("id", id)
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .eq("status", from)
          .select("id"),
      ) as { id: string }[];
      return rows.length > 0;
    },

    async claimAttachments(ids, messageId) {
      if (ids.length === 0) return true;
      const rows = check(
        await attachments()
          .update({ message_id: messageId })
          .in("id", ids)
          .is("message_id", null)
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .select("id"),
      ) as { id: string }[];
      return rows.length === new Set(ids).size;
    },

    async listAttachments(messageId) {
      const rows = check(
        await attachments()
          .select(ATTACHMENT_COLUMNS)
          .eq("message_id", messageId)
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .order("created_at", { ascending: true }),
      ) as AttachmentRow[];
      return rows.map((r) => ({ ...toAttachment(r), storagePath: r.storage_path }));
    },

    async getAttachment(id) {
      const row = check(
        await attachments().select(ATTACHMENT_COLUMNS).eq("id", id).eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle(),
      ) as AttachmentRow | null;
      return row ? { ...toAttachment(row), storagePath: row.storage_path } : null;
    },

    async attachmentPaths(conversationId) {
      const ids = (
        check(
          await messages().select("id").eq("conversation_id", conversationId).eq("workspace_id", workspaceId).eq("user_id", userId),
        ) as { id: string }[]
      ).map((m) => m.id);
      if (ids.length === 0) return [];
      const rows = check(
        await attachments().select("storage_path").in("message_id", ids).eq("workspace_id", workspaceId).eq("user_id", userId),
      ) as { storage_path: string }[];
      return rows.map((r) => r.storage_path);
    },

    async allAttachmentPaths() {
      const rows = check(
        await attachments()
          .select("storage_path")
          .not("message_id", "is", null)
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId),
      ) as { storage_path: string }[];
      return rows.map((r) => r.storage_path);
    },
  };
}

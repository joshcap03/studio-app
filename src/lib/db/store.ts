import type { Db } from "@/lib/supabase/server";
import type {
  ActivityStep,
  Approval,
  Artifact,
  Attachment,
  ChatMessage,
  ConversationSummary,
  MemoryProposal,
  MessageSkill,
  MessageStatus,
  Question,
  Timeline,
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
  questions?: Question[] | null;
  error?: string | null;
}

/** An approval as the server sees it: with what the provider needs to continue the run. */
export interface StoredApproval extends Approval {
  conversationId: string;
  messageId: string;
  provider: string;
  providerState: unknown;
}

export type NewApproval = Omit<StoredApproval, "id" | "status" | "createdAt" | "decidedAt">;

/** An attachment with where its bytes live. Server-side only. */
export interface StoredAttachment extends Attachment {
  storagePath: string;
}

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
  setAgentThread(conversationId: string, provider: string, threadId: string): Promise<void>;
  touchConversation(conversationId: string): Promise<ConversationSummary>;
  listMessages(conversationId: string): Promise<ChatMessage[]>;
  insertMessage(message: Omit<ChatMessage, "createdAt">): Promise<ChatMessage>;
  updateMessage(id: string, patch: MessagePatch): Promise<void>;
  deleteMessage(id: string): Promise<void>;
  /** Deletes every message that comes after `messageId` in its conversation. */
  deleteMessagesAfter(conversationId: string, messageId: string): Promise<void>;

  createApproval(approval: NewApproval): Promise<StoredApproval>;
  getApproval(id: string): Promise<StoredApproval | null>;
  /** The conversation's undecided approval, if any. */
  pendingApproval(conversationId: string): Promise<StoredApproval | null>;
  /** Moves an approval from one status to another; false if it wasn't in `from` (e.g. decided elsewhere). */
  settleApproval(id: string, from: Approval["status"], to: Approval["status"]): Promise<boolean>;

  /** Attaches uploaded, not-yet-sent files to a message. False unless every id was claimable. */
  claimAttachments(ids: string[], messageId: string): Promise<boolean>;
  listAttachments(messageId: string): Promise<StoredAttachment[]>;
  getAttachment(id: string): Promise<StoredAttachment | null>;
  /** Storage paths of every file attached in a conversation (for cleanup on delete). */
  attachmentPaths(conversationId: string): Promise<string[]>;
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
  questions: Question[] | null;
  error: string | null;
  skill: MessageSkill | null;
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
}

interface AttachmentRow {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  storage_path: string;
}

const CONVERSATION_COLUMNS = "id, title, project_id, agent_provider, agent_thread_id, created_at, updated_at";
// Embedded approvals and attachments leave out provider state and storage paths: these rows
// go to the browser.
const MESSAGE_COLUMNS =
  "id, conversation_id, role, content, status, activity, artifacts, memory_proposals, timeline, questions, error, skill, created_at, updated_at, " +
  "approvals(id, conversation_id, message_id, summary, app, details, status, created_at, decided_at), " +
  "attachments(id, name, mime_type, size)";
const APPROVAL_COLUMNS = "id, conversation_id, message_id, summary, app, details, status, provider, provider_state, created_at, decided_at";
const ATTACHMENT_COLUMNS = "id, name, mime_type, size, storage_path";

const toApproval = (r: Omit<ApprovalRow, "provider" | "provider_state">): Approval => ({
  id: r.id,
  summary: r.summary,
  app: r.app ?? undefined,
  details: Array.isArray(r.details) ? r.details : [],
  status: r.status,
  createdAt: Date.parse(r.created_at),
  decidedAt: r.decided_at ? Date.parse(r.decided_at) : undefined,
});

const toStoredApproval = (r: ApprovalRow): StoredApproval => ({
  ...toApproval(r),
  conversationId: r.conversation_id,
  messageId: r.message_id,
  provider: r.provider,
  providerState: r.provider_state,
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

/** How long a `streaming` message may go without a checkpoint before it counts as interrupted. */
export const STALE_STREAM_MS = 60_000;

const toMessage = (r: MessageRow): ChatMessage => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  content: r.content,
  status: r.status === "streaming" && Date.now() - Date.parse(r.updated_at) > STALE_STREAM_MS ? "interrupted" : r.status,
  activity: r.activity ?? [],
  artifacts: r.artifacts ?? [],
  approvals: (r.approvals ?? []).map(toApproval).sort((a, b) => a.createdAt - b.createdAt),
  memoryProposals: r.memory_proposals ?? [],
  timeline: r.timeline ?? null,
  questions: r.questions ?? null,
  attachments: (r.attachments ?? []).map(toAttachment),
  error: r.error,
  skill: r.skill ? { id: String(r.skill.id), name: String(r.skill.name) } : null,
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
      if (patch.questions !== undefined) values.questions = patch.questions;
      if (patch.error !== undefined) values.error = patch.error;
      check(await messages().update(values).eq("id", id).eq("workspace_id", workspaceId).eq("user_id", userId));
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

    async settleApproval(id, from, to) {
      const rows = check(
        await approvals()
          .update({ status: to, decided_at: new Date().toISOString() })
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
  };
}

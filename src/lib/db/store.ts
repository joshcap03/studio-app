import type { Db } from "@/lib/supabase/server";
import type { ActivityStep, Artifact, ChatMessage, ConversationSummary, MessageStatus } from "@/lib/types";

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
  error?: string | null;
}

export interface Store {
  readonly scope: Scope;
  listConversations(query?: string): Promise<ConversationSummary[]>;
  getConversation(id: string): Promise<Conversation | null>;
  createConversation(input: { id: string; title: string }): Promise<Conversation>;
  renameConversation(id: string, title: string): Promise<ConversationSummary | null>;
  deleteConversation(id: string): Promise<boolean>;
  setAgentThread(conversationId: string, provider: string, threadId: string): Promise<void>;
  touchConversation(conversationId: string): Promise<ConversationSummary>;
  listMessages(conversationId: string): Promise<ChatMessage[]>;
  insertMessage(message: Omit<ChatMessage, "createdAt">): Promise<ChatMessage>;
  updateMessage(id: string, patch: MessagePatch): Promise<void>;
  deleteMessage(id: string): Promise<void>;
}

interface ConversationRow {
  id: string;
  title: string;
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
  error: string | null;
  created_at: string;
  updated_at: string;
}

const CONVERSATION_COLUMNS = "id, title, agent_provider, agent_thread_id, created_at, updated_at";
const MESSAGE_COLUMNS = "id, conversation_id, role, content, status, activity, artifacts, error, created_at, updated_at";

const toSummary = (r: ConversationRow): ConversationSummary => ({
  id: r.id,
  title: r.title,
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
  error: r.error,
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

    async createConversation({ id, title }) {
      const row = check(
        await conversations()
          .insert({ id, title, workspace_id: workspaceId, user_id: userId })
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
      ) as MessageRow[];
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
            error: m.error ?? null,
          })
          .select(MESSAGE_COLUMNS)
          .single(),
      ) as MessageRow;
      return toMessage(row);
    },

    async updateMessage(id, patch) {
      const values: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (patch.content !== undefined) values.content = patch.content;
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.activity !== undefined) values.activity = patch.activity;
      if (patch.artifacts !== undefined) values.artifacts = patch.artifacts;
      if (patch.error !== undefined) values.error = patch.error;
      check(await messages().update(values).eq("id", id).eq("workspace_id", workspaceId).eq("user_id", userId));
    },

    async deleteMessage(id) {
      check(await messages().delete().eq("id", id).eq("workspace_id", workspaceId).eq("user_id", userId));
    },
  };
}

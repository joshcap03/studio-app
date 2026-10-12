import type { ActivityStep, Artifact, ChatMessage, ConversationSummary, MessageStatus } from "@/lib/types";
import { getConfig } from "@/lib/config";
import { openDatabase, type Database } from "./sqlite";

// The persistence boundary. Everything above this file speaks domain types; everything
// below is SQL. Swapping SQLite for Postgres means reimplementing this interface only.

export interface Conversation extends ConversationSummary {
  userId: string;
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
  ensureUser(userId: string): void;
  listConversations(userId: string, query?: string): ConversationSummary[];
  getConversation(userId: string, id: string): Conversation | null;
  createConversation(userId: string, input: { id: string; title: string; now?: number }): Conversation;
  renameConversation(userId: string, id: string, title: string): ConversationSummary | null;
  deleteConversation(userId: string, id: string): boolean;
  setAgentThreadId(conversationId: string, threadId: string): void;
  touchConversation(conversationId: string, now?: number): ConversationSummary;
  listMessages(conversationId: string): ChatMessage[];
  insertMessage(message: ChatMessage): void;
  updateMessage(id: string, patch: MessagePatch): void;
  deleteMessage(id: string): void;
}

interface ConversationRow {
  id: string;
  user_id: string;
  title: string;
  agent_thread_id: string | null;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  activity: string;
  artifacts: string;
  error: string | null;
  created_at: number;
}

const toSummary = (r: ConversationRow): ConversationSummary => ({
  id: r.id,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toConversation = (r: ConversationRow): Conversation => ({
  ...toSummary(r),
  userId: r.user_id,
  agentThreadId: r.agent_thread_id,
});

const toMessage = (r: MessageRow): ChatMessage => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  content: r.content,
  status: r.status,
  activity: JSON.parse(r.activity) as ActivityStep[],
  artifacts: JSON.parse(r.artifacts) as Artifact[],
  error: r.error,
  createdAt: r.created_at,
});

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function createStore(db: Database): Store {
  return {
    ensureUser(userId) {
      db.prepare("INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)").run(userId, Date.now());
    },

    listConversations(userId, query) {
      const q = query?.trim();
      if (!q) {
        const rows = db
          .prepare("SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 500")
          .all(userId) as unknown as ConversationRow[];
        return rows.map(toSummary);
      }
      const pattern = `%${escapeLike(q)}%`;
      const rows = db
        .prepare(
          `SELECT c.* FROM conversations c
           WHERE c.user_id = ?
             AND (c.title LIKE ? ESCAPE '\\'
                  OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ? ESCAPE '\\'))
           ORDER BY c.updated_at DESC LIMIT 100`,
        )
        .all(userId, pattern, pattern) as unknown as ConversationRow[];
      return rows.map(toSummary);
    },

    getConversation(userId, id) {
      const row = db.prepare("SELECT * FROM conversations WHERE id = ? AND user_id = ?").get(id, userId) as
        | ConversationRow
        | undefined;
      return row ? toConversation(row) : null;
    },

    createConversation(userId, { id, title, now = Date.now() }) {
      db.prepare(
        "INSERT INTO conversations (id, user_id, title, agent_thread_id, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)",
      ).run(id, userId, title, now, now);
      return { id, userId, title, agentThreadId: null, createdAt: now, updatedAt: now };
    },

    renameConversation(userId, id, title) {
      const result = db.prepare("UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?").run(title, id, userId);
      if (result.changes === 0) return null;
      const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as unknown as ConversationRow;
      return toSummary(row);
    },

    deleteConversation(userId, id) {
      return db.prepare("DELETE FROM conversations WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
    },

    setAgentThreadId(conversationId, threadId) {
      db.prepare("UPDATE conversations SET agent_thread_id = ? WHERE id = ?").run(threadId, conversationId);
    },

    touchConversation(conversationId, now = Date.now()) {
      db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, conversationId);
      const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId) as unknown as ConversationRow;
      return toSummary(row);
    },

    listMessages(conversationId) {
      const rows = db
        .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid")
        .all(conversationId) as unknown as MessageRow[];
      return rows.map(toMessage);
    },

    insertMessage(m) {
      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, status, activity, artifacts, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        m.id,
        m.conversationId,
        m.role,
        m.content,
        m.status,
        JSON.stringify(m.activity),
        JSON.stringify(m.artifacts),
        m.error ?? null,
        m.createdAt,
      );
    },

    updateMessage(id, patch) {
      const sets: string[] = [];
      const values: (string | null)[] = [];
      if (patch.content !== undefined) (sets.push("content = ?"), values.push(patch.content));
      if (patch.status !== undefined) (sets.push("status = ?"), values.push(patch.status));
      if (patch.activity !== undefined) (sets.push("activity = ?"), values.push(JSON.stringify(patch.activity)));
      if (patch.artifacts !== undefined) (sets.push("artifacts = ?"), values.push(JSON.stringify(patch.artifacts)));
      if (patch.error !== undefined) (sets.push("error = ?"), values.push(patch.error));
      if (sets.length === 0) return;
      db.prepare(`UPDATE messages SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    },

    deleteMessage(id) {
      db.prepare("DELETE FROM messages WHERE id = ?").run(id);
    },
  };
}

let defaultStore: Store | undefined;

/** The application's store, backed by the configured database file. */
export function getStore(): Store {
  return (defaultStore ??= createStore(openDatabase(getConfig().databasePath)));
}

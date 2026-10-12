import type { Conversation, MessagePatch, Scope, Store } from "@/lib/db/store";
import type { ChatMessage } from "@/lib/types";

/** In-memory Store for unit tests. Mirrors the Supabase store's per-tenant scoping. */
export function createMemoryStore(scope: Scope, shared: MemoryDb = createMemoryDb()): Store {
  const owns = (c: { workspaceId: string; userId: string }) => c.workspaceId === scope.workspaceId && c.userId === scope.userId;
  return {
    scope,
    async listConversations(query) {
      const q = query?.trim().toLowerCase();
      return [...shared.conversations.values()]
        .filter(owns)
        .filter((c) => !q || c.title.toLowerCase().includes(q) || shared.messages.some((m) => m.conversationId === c.id && m.content.toLowerCase().includes(q)))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }));
    },
    async getConversation(id) {
      const c = shared.conversations.get(id);
      return c && owns(c) ? strip(c) : null;
    },
    async createConversation({ id, title }) {
      if (shared.conversations.has(id)) throw new Error("duplicate key value violates unique constraint");
      const now = Date.now();
      const c = { id, title, createdAt: now, updatedAt: now, agentProvider: null, agentThreadId: null, ...scope };
      shared.conversations.set(id, c);
      return strip(c);
    },
    async renameConversation(id, title) {
      const c = shared.conversations.get(id);
      if (!c || !owns(c)) return null;
      c.title = title;
      return { id, title, createdAt: c.createdAt, updatedAt: c.updatedAt };
    },
    async deleteConversation(id) {
      const c = shared.conversations.get(id);
      if (!c || !owns(c)) return false;
      shared.conversations.delete(id);
      shared.messages = shared.messages.filter((m) => m.conversationId !== id);
      return true;
    },
    async setAgentThread(id, provider, threadId) {
      const c = shared.conversations.get(id);
      if (c && owns(c)) Object.assign(c, { agentProvider: provider, agentThreadId: threadId });
    },
    async touchConversation(id) {
      const c = shared.conversations.get(id)!;
      c.updatedAt = Date.now();
      return { id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt };
    },
    async listMessages(conversationId) {
      const c = shared.conversations.get(conversationId);
      if (!c || !owns(c)) return [];
      return shared.messages.filter((m) => m.conversationId === conversationId).map((m) => ({ ...m }));
    },
    async insertMessage(m) {
      const c = shared.conversations.get(m.conversationId);
      if (!c || !owns(c)) throw new Error("violates foreign key constraint");
      const row: ChatMessage = { ...m, createdAt: Date.now() };
      shared.messages.push(row);
      return { ...row };
    },
    async updateMessage(id, patch: MessagePatch) {
      const m = shared.messages.find((x) => x.id === id);
      if (m) Object.assign(m, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    },
    async deleteMessage(id) {
      shared.messages = shared.messages.filter((m) => m.id !== id);
    },
  };
}

type Row = Conversation & Scope;
export interface MemoryDb {
  conversations: Map<string, Row>;
  messages: ChatMessage[];
}
export const createMemoryDb = (): MemoryDb => ({ conversations: new Map(), messages: [] });
const strip = ({ workspaceId: _w, userId: _u, ...c }: Row): Conversation => ({ ...c });

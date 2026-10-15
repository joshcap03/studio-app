import type { Conversation, MessagePatch, Scope, Store, StoredApproval, StoredAttachment } from "@/lib/db/store";
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
        .map(summary);
    },
    async listProjectConversations(projectId) {
      return [...shared.conversations.values()]
        .filter((c) => owns(c) && c.projectId === projectId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(summary);
    },
    async getConversation(id) {
      const c = shared.conversations.get(id);
      return c && owns(c) ? strip(c) : null;
    },
    async createConversation({ id, title, projectId = null }) {
      if (shared.conversations.has(id)) throw new Error("duplicate key value violates unique constraint");
      const now = Date.now();
      const c = { id, title, projectId, createdAt: now, updatedAt: now, agentProvider: null, agentThreadId: null, ...scope };
      shared.conversations.set(id, c);
      return strip(c);
    },
    async renameConversation(id, title) {
      const c = shared.conversations.get(id);
      if (!c || !owns(c)) return null;
      c.title = title;
      return summary(c);
    },
    async moveConversation(id, projectId) {
      const c = shared.conversations.get(id);
      if (!c || !owns(c)) return null;
      c.projectId = projectId;
      return summary(c);
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
      return summary(c);
    },
    async listMessages(conversationId) {
      const c = shared.conversations.get(conversationId);
      if (!c || !owns(c)) return [];
      // Like the Supabase store, approvals and attachments come embedded (without server-only fields).
      return shared.messages
        .filter((m) => m.conversationId === conversationId)
        .map((m) => ({
          ...m,
          approvals: shared.approvals
            .filter((a) => a.messageId === m.id)
            .map(({ id, summary, app, details, status, createdAt, decidedAt }) => ({ id, summary, app, details, status, createdAt, decidedAt })),
          attachments: shared.attachments.filter((a) => a.messageId === m.id).map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })),
          memoryProposals: m.memoryProposals ?? [],
        }));
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
      shared.approvals = shared.approvals.filter((a) => a.messageId !== id);
    },
    async deleteMessagesAfter(conversationId, messageId) {
      const c = shared.conversations.get(conversationId);
      if (!c || !owns(c)) return;
      const inConversation = shared.messages.filter((m) => m.conversationId === conversationId);
      const index = inConversation.findIndex((m) => m.id === messageId);
      if (index < 0) return;
      const doomed = new Set(inConversation.slice(index + 1).map((m) => m.id));
      shared.messages = shared.messages.filter((m) => !doomed.has(m.id));
      shared.approvals = shared.approvals.filter((a) => !doomed.has(a.messageId));
    },
    async createApproval(a) {
      const c = shared.conversations.get(a.conversationId);
      if (!c || !owns(c)) throw new Error("violates foreign key constraint");
      if (shared.approvals.some((x) => x.conversationId === a.conversationId && x.status === "pending")) {
        throw new Error("duplicate key value violates unique constraint");
      }
      const row: StoredApproval & Scope = { ...a, ...scope, id: crypto.randomUUID(), status: "pending", createdAt: Date.now() };
      shared.approvals.push(row);
      return stripScope(row);
    },
    async getApproval(id) {
      const a = shared.approvals.find((x) => x.id === id);
      return a && owns(a) ? stripScope(a) : null;
    },
    async pendingApproval(conversationId) {
      const a = shared.approvals.find((x) => x.conversationId === conversationId && x.status === "pending" && owns(x));
      return a ? stripScope(a) : null;
    },
    async settleApproval(id, from, to) {
      const a = shared.approvals.find((x) => x.id === id && owns(x) && x.status === from);
      if (!a) return false;
      a.status = to;
      a.decidedAt = Date.now();
      return true;
    },
    async claimAttachments(ids, messageId) {
      const claimable = shared.attachments.filter((a) => ids.includes(a.id) && owns(a) && !a.messageId);
      if (claimable.length !== new Set(ids).size) return false;
      for (const a of claimable) a.messageId = messageId;
      return true;
    },
    async listAttachments(messageId) {
      return shared.attachments.filter((a) => a.messageId === messageId && owns(a)).map(({ workspaceId: _w, userId: _u, messageId: _m, ...a }) => a);
    },
    async getAttachment(id) {
      const a = shared.attachments.find((x) => x.id === id && owns(x));
      if (!a) return null;
      const { workspaceId: _w, userId: _u, messageId: _m, ...rest } = a;
      return rest;
    },
    async attachmentPaths(conversationId) {
      const ids = new Set(shared.messages.filter((m) => m.conversationId === conversationId).map((m) => m.id));
      return shared.attachments.filter((a) => owns(a) && a.messageId && ids.has(a.messageId)).map((a) => a.storagePath);
    },
  };
}

type Row = Conversation & Scope;
export type MemoryAttachment = StoredAttachment & Scope & { messageId: string | null };
export interface MemoryDb {
  conversations: Map<string, Row>;
  messages: ChatMessage[];
  approvals: (StoredApproval & Scope)[];
  attachments: MemoryAttachment[];
}
export const createMemoryDb = (): MemoryDb => ({ conversations: new Map(), messages: [], approvals: [], attachments: [] });
const stripScope = ({ workspaceId: _w, userId: _u, ...a }: StoredApproval & Scope): StoredApproval => ({ ...a });
const summary = ({ id, title, projectId, createdAt, updatedAt }: Row) => ({ id, title, projectId, createdAt, updatedAt });
const strip = ({ workspaceId: _w, userId: _u, ...c }: Row): Conversation => ({ ...c });

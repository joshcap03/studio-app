import { getConfig } from "@/lib/config";
import type { Tenant } from "@/lib/tenant";
import { toMemoryCategory, type Memory, type MemoryCategory } from "@/lib/types";

// Long-term memory, kept in Supermemory (v5 API). Every call is scoped to a namespace
// derived from the caller's session: one per workspace for shared facts, and one per member
// of a workspace for personal ones. Nothing outside this module, the agent included, names
// a namespace, so one workspace can never read or write another's memory.

const TIMEOUT_MS = 8_000;
/** Recall runs before every reply; past this it is skipped rather than delaying the answer. */
const RECALL_TIMEOUT_MS = 2_500;
const RECALL_BUDGET = 6_000;

type Scope = Memory["scope"];

export class MemoryUnavailableError extends Error {
  readonly status = 503;
  constructor() {
    super("Memory isn't set up for this app yet.");
  }
}

export function memoryEnabled(): boolean {
  return Boolean(getConfig().supermemory);
}

export function namespaceFor(tenant: Pick<Tenant, "workspace" | "userId">, scope: Scope): string {
  const base = `ws_${tenant.workspace.id}`;
  return scope === "personal" ? `${base}_u_${tenant.userId}` : base;
}

const ID = /^(workspace|personal):([A-Za-z0-9_-]{1,255})$/;

/** Memory ids the browser sees carry their scope, so the namespace never comes from input. */
export function parseMemoryId(id: string): { scope: Scope; documentId: string } | null {
  const m = ID.exec(id);
  return m ? { scope: m[1] as Scope, documentId: m[2] } : null;
}

async function call<T>(tenant: Tenant, scope: Scope, path: string, init: { method: string; body?: unknown }, timeoutMs = TIMEOUT_MS): Promise<T> {
  const config = getConfig().supermemory;
  if (!config) throw new MemoryUnavailableError();
  const url = new URL(`ns/${encodeURIComponent(namespaceFor(tenant, scope))}/${path}`, config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`);
  const response = await fetch(url, {
    method: init.method,
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 404) throw Object.assign(new Error("Memory not found."), { status: 404 });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Supermemory ${init.method} ${path} failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

interface DocumentRow {
  id: string;
  title?: string | null;
  summary?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown>;
  system?: { createdAt?: string };
}

function toMemory(tenant: Tenant, scope: Scope, doc: DocumentRow): Memory {
  const meta = doc.metadata ?? {};
  const text = typeof meta.text === "string" ? meta.text : (doc.content ?? doc.summary ?? doc.title ?? "");
  const conversationId = typeof meta.sourceConversation === "string" ? meta.sourceConversation : undefined;
  const messageId = typeof meta.sourceMessage === "string" ? meta.sourceMessage : undefined;
  return {
    id: `${scope}:${doc.id}`,
    content: text,
    scope,
    // An edited fact is a new document; savedAt keeps the original time.
    createdAt: (typeof meta.savedAt === "number" ? meta.savedAt : 0) || Date.parse(doc.system?.createdAt ?? "") || 0,
    mine: scope === "personal" || meta.createdBy === tenant.userId,
    category: toMemoryCategory(meta.category),
    pinned: meta.pinned === true,
    source: conversationId && messageId ? { conversationId, messageId } : undefined,
  };
}

export interface RememberOptions {
  category?: MemoryCategory;
  pinned?: boolean;
  source?: Memory["source"];
  /** Who the fact is credited to, when it isn't the caller (an owner approving a share). */
  createdBy?: string;
  /** Keeps the original save time when a fact is edited. */
  savedAt?: number;
}

/** Saves one fact. `instant` processing makes it recallable on the very next message. */
export async function remember(tenant: Tenant, content: string, scope: Scope, options: RememberOptions = {}): Promise<Memory> {
  const text = content.replace(/\s+/g, " ").trim();
  const category = toMemoryCategory(options.category);
  const savedAt = options.savedAt ?? Date.now();
  // Supermemory metadata holds flat values only.
  const metadata: Record<string, string | number | boolean> = {
    source: "studio",
    text,
    createdBy: options.createdBy ?? tenant.userId,
    category,
    savedAt,
  };
  if (options.pinned) metadata.pinned = true;
  if (options.source) {
    metadata.sourceConversation = options.source.conversationId;
    metadata.sourceMessage = options.source.messageId;
  }
  const doc = await call<{ id: string }>(tenant, scope, "document", {
    method: "POST",
    body: { content: text, metadata, dreaming: "instant" },
  });
  return {
    id: `${scope}:${doc.id}`,
    content: text,
    scope,
    createdAt: savedAt,
    mine: scope === "personal" || metadata.createdBy === tenant.userId,
    category,
    pinned: Boolean(options.pinned),
    source: options.source,
  };
}

/** What this member can see: the workspace's shared memory and their own. */
export async function listMemories(tenant: Tenant, limit = 100): Promise<Memory[]> {
  const [shared, personal] = await Promise.all([listScope(tenant, "workspace", limit), listScope(tenant, "personal", limit)]);
  return [...shared, ...personal].sort((a, b) => b.createdAt - a.createdAt);
}

function listScope(tenant: Tenant, scope: Scope, limit: number, timeoutMs = TIMEOUT_MS): Promise<Memory[]> {
  return call<{ documents?: DocumentRow[] }>(
    tenant,
    scope,
    `list/documents?limit=${limit}&sort=createdAt&order=desc`,
    { method: "POST", body: {} },
    timeoutMs,
  ).then((r) => (r.documents ?? []).map((d) => toMemory(tenant, scope, d)).filter((m) => m.content));
}

/** Fetches one memory, or null if it's gone. */
export async function getMemory(tenant: Tenant, id: string): Promise<Memory | null> {
  const parsed = parseMemoryId(id);
  if (!parsed) return null;
  const doc = await fetchDocument(tenant, parsed.scope, parsed.documentId);
  return doc ? toMemory(tenant, parsed.scope, doc) : null;
}

function fetchDocument(tenant: Tenant, scope: Scope, documentId: string): Promise<DocumentRow | null> {
  return call<DocumentRow>(tenant, scope, `document/${encodeURIComponent(documentId)}`, { method: "GET" }).catch(
    (error: { status?: number }) => {
      if (error?.status === 404) return null;
      throw error;
    },
  );
}

/**
 * Personal memories are the member's own; a shared one can be changed or removed by whoever
 * saved it or a workspace owner. Returns the document, or null if it's gone.
 */
async function documentToModify(tenant: Tenant, scope: Scope, documentId: string): Promise<DocumentRow | null> {
  const doc = await fetchDocument(tenant, scope, documentId);
  if (doc && scope === "workspace" && tenant.workspace.role !== "owner" && doc.metadata?.createdBy !== tenant.userId) {
    throw Object.assign(new Error("Only the person who saved this or a workspace owner can change it."), { status: 403 });
  }
  return doc;
}

/** Removes a memory and everything Supermemory learned from it. */
export async function forget(tenant: Tenant, id: string): Promise<boolean> {
  const parsed = parseMemoryId(id);
  if (!parsed) return false;
  if (parsed.scope === "workspace" && tenant.workspace.role !== "owner") {
    const doc = await documentToModify(tenant, parsed.scope, parsed.documentId);
    if (!doc) return false;
  }
  return deleteDocument(tenant, parsed.scope, parsed.documentId);
}

async function deleteDocument(tenant: Tenant, scope: Scope, documentId: string): Promise<boolean> {
  const result = await call<{ count: number }>(tenant, scope, "document", { method: "DELETE", body: { ids: [documentId] } });
  return result.count > 0;
}

export interface MemoryChange {
  content?: string;
  category?: MemoryCategory;
  pinned?: boolean;
}

/**
 * Edits a memory. Supermemory documents can't be updated in place, so this saves the new
 * version (keeping who saved it, when, and where from) and then removes the old one.
 */
export async function replaceMemory(tenant: Tenant, id: string, change: MemoryChange): Promise<Memory | null> {
  const parsed = parseMemoryId(id);
  if (!parsed) return null;
  const doc = await documentToModify(tenant, parsed.scope, parsed.documentId);
  if (!doc) return null;
  const current = toMemory(tenant, parsed.scope, doc);
  const createdBy = typeof doc.metadata?.createdBy === "string" ? doc.metadata.createdBy : tenant.userId;
  const next = await remember(tenant, change.content ?? current.content, parsed.scope, {
    category: change.category ?? current.category,
    pinned: change.pinned ?? current.pinned,
    source: current.source,
    createdBy,
    savedAt: current.createdAt || undefined,
  });
  await deleteDocument(tenant, parsed.scope, parsed.documentId);
  return { ...next, mine: parsed.scope === "personal" || createdBy === tenant.userId };
}

interface ProfileResponse {
  profile?: { static?: { memory: string }[]; dynamic?: { memory: string }[] };
}
interface SearchResponse {
  results?: { memory?: string; chunk?: string }[];
}

/**
 * What to search memory for on a turn: the member's last few messages, newest first. A short
 * follow-up ("any that sell to resellers?") says nothing about the topic, so on its own it
 * would only match the business's standing facts.
 */
export function recallQuery(asks: string[], count = 3): string | undefined {
  const recent = asks.map((a) => a.trim()).filter(Boolean).slice(-count).reverse();
  return recent.length ? recent.join("\n") : undefined;
}

/**
 * What the agent should know going into a reply: the standing profile of the business and
 * of this member, plus anything that matches the message. Never blocks the reply: if memory
 * is slow or down, the agent answers without it. With `pinned`, facts the members pinned come
 * first.
 */
export async function recall(tenant: Tenant, query?: string, options: { pinned?: boolean } = {}): Promise<string[]> {
  if (!memoryEnabled()) return [];
  const q = query?.replace(/\s+/g, " ").trim().slice(0, 1000);
  const safe = <T>(p: Promise<T>) =>
    p.catch((error) => {
      console.error("[memory] recall failed", error);
      return undefined;
    });
  const profile = (scope: Scope) => safe(call<ProfileResponse>(tenant, scope, "profile", { method: "POST", body: {} }, RECALL_TIMEOUT_MS));
  const search = (scope: Scope) =>
    q
      ? safe(call<SearchResponse>(tenant, scope, "search", { method: "POST", body: { query: q, searchMode: "memories", limit: 6 } }, RECALL_TIMEOUT_MS))
      : Promise.resolve(undefined);
  const pinned = (scope: Scope) =>
    options.pinned ? safe(listScope(tenant, scope, 100, RECALL_TIMEOUT_MS).then((ms) => ms.filter((m) => m.pinned))) : Promise.resolve(undefined);
  const [sharedProfile, personalProfile, sharedHits, personalHits, sharedPinned, personalPinned] = await Promise.all([
    profile("workspace"),
    profile("personal"),
    search("workspace"),
    search("personal"),
    pinned("workspace"),
    pinned("personal"),
  ]);

  const facts = [
    ...(sharedPinned ?? []).map((m) => m.content),
    ...(personalPinned ?? []).map((m) => m.content),
    ...(sharedHits?.results ?? []).map((r) => r.memory),
    ...(personalHits?.results ?? []).map((r) => r.memory),
    ...(sharedProfile?.profile?.static ?? []).map((m) => m.memory),
    ...(personalProfile?.profile?.static ?? []).map((m) => m.memory),
    ...(sharedProfile?.profile?.dynamic ?? []).map((m) => m.memory),
    ...(personalProfile?.profile?.dynamic ?? []).map((m) => m.memory),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const fact of facts) {
    const text = fact?.replace(/\s+/g, " ").trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    if (used + text.length > RECALL_BUDGET) break;
    seen.add(text.toLowerCase());
    out.push(text);
    used += text.length;
  }
  return out;
}

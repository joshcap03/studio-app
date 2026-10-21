import { getConfig } from "@/lib/config";
import type { Tenant } from "@/lib/tenant-core";
import { toMemoryCategory, type MergedOriginal, type Memory, type MemoryCategory } from "@/lib/types";

// Long-term memory, kept in Supermemory (v5 API). Every call is scoped to a namespace
// derived from the caller's session: one per workspace (agent) for its shared facts, and one
// per person for personal ones, which all of that person's agents share. Nothing outside this
// module, the agent included, names a namespace, so one workspace can never read or write
// another's memory, nor one person another's.
//
// Personal memory used to be kept per workspace (`ws_<workspace>_u_<user>`). Those "legacy"
// namespaces are moved into the person's own the first time they use that agent after the
// change (moveLegacyPersonal), and read alongside it until the move is done, so nothing is lost.

const TIMEOUT_MS = 8_000;
/** Recall runs before every reply; past this it is skipped rather than delaying the answer. */
const RECALL_TIMEOUT_MS = 2_500;
const RECALL_BUDGET = 6_000;
/** Supermemory returns at most this many rows per page. */
const PAGE = 100;

type Scope = Memory["scope"];
/** Where a document lives: a scope's namespace, or the person's old per-workspace one. */
type Where = Scope | "legacy";

export class MemoryUnavailableError extends Error {
  readonly status = 503;
  constructor() {
    super("Memory isn't set up for this app yet.");
  }
}

export function memoryEnabled(): boolean {
  return Boolean(getConfig().supermemory);
}

export function namespaceFor(tenant: Pick<Tenant, "workspace" | "userId">, where: Where): string {
  switch (where) {
    case "workspace":
      return `ws_${tenant.workspace.id}`;
    case "personal":
      return `u_${tenant.userId}`;
    case "legacy":
      return `ws_${tenant.workspace.id}_u_${tenant.userId}`;
  }
}

const ID = /^(workspace|personal|legacy):([A-Za-z0-9_-]{1,255})$/;

/**
 * Memory ids the browser sees carry where they live, so the namespace never comes from input.
 * A legacy personal memory's scope is "personal".
 */
export function parseMemoryId(id: string): { scope: Scope; where: Where; documentId: string } | null {
  const m = ID.exec(id);
  if (!m) return null;
  const where = m[1] as Where;
  return { scope: where === "workspace" ? "workspace" : "personal", where, documentId: m[2] };
}

async function call<T>(tenant: Tenant, where: Where, path: string, init: { method: string; body?: unknown }, timeoutMs = TIMEOUT_MS): Promise<T> {
  const config = getConfig().supermemory;
  if (!config) throw new MemoryUnavailableError();
  const url = new URL(`ns/${encodeURIComponent(namespaceFor(tenant, where))}/${path}`, config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`);
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

function toMemory(tenant: Tenant, where: Where, doc: DocumentRow): Memory {
  const scope: Scope = where === "workspace" ? "workspace" : "personal";
  const meta = doc.metadata ?? {};
  const text = typeof meta.text === "string" ? meta.text : (doc.content ?? doc.summary ?? doc.title ?? "");
  const conversationId = typeof meta.sourceConversation === "string" ? meta.sourceConversation : undefined;
  const messageId = typeof meta.sourceMessage === "string" ? meta.sourceMessage : undefined;
  return {
    id: `${where}:${doc.id}`,
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
  /** The legacy document this is a moved copy of. */
  movedFrom?: string;
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
  if (options.movedFrom) metadata.movedFrom = options.movedFrom;
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

/** How many facts per scope the Brain lists: well past one page. */
const LIST_MAX = 1_000;

/** What this member can see: the workspace's shared memory and their own. */
export async function listMemories(tenant: Tenant, limit = LIST_MAX): Promise<Memory[]> {
  const moved = await moveLegacyPersonal(tenant).then(
    () => true,
    (error) => {
      console.error("[memory] couldn't move personal memories", error);
      return false;
    },
  );
  const [shared, personal, legacy] = await Promise.all([
    listAll(tenant, "workspace", limit),
    listAll(tenant, "personal", limit),
    moved ? [] : listAll(tenant, "legacy", limit),
  ]);
  return [...shared, ...personal, ...legacy].sort((a, b) => b.createdAt - a.createdAt);
}

function listDocuments(tenant: Tenant, where: Where, limit: number, timeoutMs = TIMEOUT_MS, page?: number): Promise<DocumentRow[]> {
  return call<{ documents?: DocumentRow[] }>(
    tenant,
    where,
    `list/documents?limit=${limit}&sort=createdAt&order=desc${page ? `&page=${page}` : ""}`,
    { method: "POST", body: {} },
    timeoutMs,
  ).then((r) => r.documents ?? []);
}

/**
 * Up to `max` of a scope's facts, newest first, a page at a time. Stops at a short page, or at
 * one that repeats what it already has (paging not honored), and keeps what it has if a later
 * page fails: the first page alone is what the Brain listed before.
 */
async function listAll(tenant: Tenant, where: Where, max: number): Promise<Memory[]> {
  const docs: DocumentRow[] = [];
  const seen = new Set<string>();
  for (let page = 1; docs.length < max; page++) {
    const batch =
      page === 1
        ? await listDocuments(tenant, where, PAGE)
        : await listDocuments(tenant, where, PAGE, TIMEOUT_MS, page).catch((error) => {
            console.error("[memory] couldn't list past the first page", error);
            return [];
          });
    const fresh = batch.filter((d) => !seen.has(d.id));
    for (const d of fresh) {
      seen.add(d.id);
      docs.push(d);
    }
    if (batch.length < PAGE || fresh.length < batch.length) break;
  }
  return docs
    .slice(0, max)
    .map((d) => toMemory(tenant, where, d))
    .filter((m) => m.content);
}

function listScope(tenant: Tenant, where: Where, limit: number, timeoutMs = TIMEOUT_MS): Promise<Memory[]> {
  return listDocuments(tenant, where, limit, timeoutMs).then((docs) => docs.map((d) => toMemory(tenant, where, d)).filter((m) => m.content));
}

// Moves already finished (or under way) in this server process, per workspace and person.
const moves = new Map<string, Promise<void>>();
const moved = new Set<string>();
const MOVE_BATCH = 100;
const MOVE_MAX_BATCHES = 20;

function moveKey(tenant: Pick<Tenant, "workspace" | "userId">): string {
  return namespaceFor(tenant, "legacy");
}

/** Forgets which moves this process has done (tests only). */
export function resetMoves(): void {
  moves.clear();
  moved.clear();
}

/**
 * Moves the person's personal memories from this workspace's old per-workspace namespace into
 * their own, so every one of their agents sees them. Each fact is copied (keeping its author,
 * time, category, pin, and source) before the old copy is removed, and a copy is never made
 * twice, so an interrupted or repeated move loses and duplicates nothing.
 */
export function moveLegacyPersonal(tenant: Tenant): Promise<void> {
  const key = moveKey(tenant);
  if (moved.has(key)) return Promise.resolve();
  let move = moves.get(key);
  if (!move) {
    move = runMove(tenant).then(
      () => {
        moved.add(key);
        moves.delete(key);
      },
      (error: unknown) => {
        moves.delete(key);
        throw error;
      },
    );
    moves.set(key, move);
  }
  return move;
}

async function runMove(tenant: Tenant): Promise<void> {
  if (!memoryEnabled()) return;
  let copied: Set<string> | null = null;
  for (let batch = 0; batch < MOVE_MAX_BATCHES; batch++) {
    const docs = await listDocuments(tenant, "legacy", MOVE_BATCH);
    if (docs.length === 0) return;
    copied ??= new Set(
      (await listDocuments(tenant, "personal", MOVE_BATCH)).flatMap((d) => (typeof d.metadata?.movedFrom === "string" ? [d.metadata.movedFrom] : [])),
    );
    for (const doc of docs) {
      const memory = toMemory(tenant, "legacy", doc);
      if (memory.content && !copied.has(doc.id)) {
        await remember(tenant, memory.content, "personal", {
          category: memory.category,
          pinned: memory.pinned,
          source: memory.source,
          createdBy: typeof doc.metadata?.createdBy === "string" ? doc.metadata.createdBy : tenant.userId,
          savedAt: memory.createdAt || undefined,
          movedFrom: doc.id,
        });
        copied.add(doc.id);
      }
    }
    await call(tenant, "legacy", "document", { method: "DELETE", body: { ids: docs.map((d) => d.id) } });
  }
  throw new Error("Too many personal memories to move at once; the rest move next time.");
}

/** Fetches one memory, or null if it's gone. */
export async function getMemory(tenant: Tenant, id: string): Promise<Memory | null> {
  const parsed = parseMemoryId(id);
  if (!parsed) return null;
  const doc = await fetchDocument(tenant, parsed.where, parsed.documentId);
  return doc ? toMemory(tenant, parsed.where, doc) : null;
}

function fetchDocument(tenant: Tenant, where: Where, documentId: string): Promise<DocumentRow | null> {
  return call<DocumentRow>(tenant, where, `document/${encodeURIComponent(documentId)}`, { method: "GET" }).catch(
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
async function documentToModify(tenant: Tenant, where: Where, documentId: string): Promise<DocumentRow | null> {
  const doc = await fetchDocument(tenant, where, documentId);
  if (doc && where === "workspace" && tenant.workspace.role !== "owner" && doc.metadata?.createdBy !== tenant.userId) {
    throw Object.assign(new Error("Only the person who saved this or the owner can change it."), { status: 403 });
  }
  return doc;
}

/** Removes a memory and everything Supermemory learned from it. */
export async function forget(tenant: Tenant, id: string): Promise<boolean> {
  const parsed = parseMemoryId(id);
  if (!parsed) return false;
  if (parsed.where === "workspace" && tenant.workspace.role !== "owner") {
    const doc = await documentToModify(tenant, parsed.where, parsed.documentId);
    if (!doc) return false;
  }
  return deleteDocument(tenant, parsed.where, parsed.documentId);
}

async function deleteDocument(tenant: Tenant, where: Where, documentId: string): Promise<boolean> {
  const result = await call<{ count: number }>(tenant, where, "document", { method: "DELETE", body: { ids: [documentId] } });
  return result.count > 0;
}

// Supermemory's limit: a filter group takes at most 200 operands.
const FILTER_OPERANDS = 200;
const FORGET_MAX_PAGES = 50;

/**
 * Forgets every fact saved from these conversations (the caller's own, which they just
 * deleted), in this agent's memory and the person's: what the agent learned in those chats
 * goes with them. Shared facts go only where the caller saved them. Facts added by hand, or
 * learned in other conversations, stay. Returns how many were forgotten.
 */
export async function forgetConversations(tenant: Tenant, conversationIds: string[]): Promise<number> {
  if (!memoryEnabled() || conversationIds.length === 0) return 0;
  let forgotten = 0;
  for (let i = 0; i < conversationIds.length; i += FILTER_OPERANDS) {
    const fromThese = {
      operator: "or",
      operands: conversationIds.slice(i, i + FILTER_OPERANDS).map((id) => ({ field: "sourceConversation", operator: "eq", value: id })),
    };
    for (const where of ["workspace", "personal", "legacy"] as const) {
      const filter =
        where === "workspace"
          ? { operator: "and", operands: [fromThese, { field: "createdBy", operator: "eq", value: tenant.userId }] }
          : fromThese;
      // Each page is deleted before the next is read, so the first page is always the rest.
      for (let page = 0; page < FORGET_MAX_PAGES; page++) {
        const { documents = [] } = await call<{ documents?: DocumentRow[] }>(tenant, where, `list/documents?limit=${PAGE}`, {
          method: "POST",
          body: { filter, include: { memoryCount: false } },
        });
        if (documents.length === 0) break;
        const { count } = await call<{ count: number }>(tenant, where, "document", { method: "DELETE", body: { ids: documents.map((d) => d.id) } });
        forgotten += count;
        if (count === 0 || documents.length < PAGE) break;
      }
    }
  }
  return forgotten;
}

export interface MemoryChange {
  content?: string;
  category?: MemoryCategory;
  pinned?: boolean;
}

/**
 * Edits a memory. Supermemory documents can't be updated in place, so this saves the new
 * version (keeping who saved it, when, and where from) and then removes the old one. An edited
 * legacy memory is saved to the person's own namespace.
 */
export async function replaceMemory(tenant: Tenant, id: string, change: MemoryChange): Promise<Memory | null> {
  const parsed = parseMemoryId(id);
  if (!parsed) return null;
  const doc = await documentToModify(tenant, parsed.where, parsed.documentId);
  if (!doc) return null;
  const current = toMemory(tenant, parsed.where, doc);
  const createdBy = typeof doc.metadata?.createdBy === "string" ? doc.metadata.createdBy : tenant.userId;
  const next = await remember(tenant, change.content ?? current.content, parsed.scope, {
    category: change.category ?? current.category,
    pinned: change.pinned ?? current.pinned,
    source: current.source,
    createdBy,
    savedAt: current.createdAt || undefined,
  });
  await deleteDocument(tenant, parsed.where, parsed.documentId);
  return { ...next, mine: parsed.scope === "personal" || createdBy === tenant.userId };
}

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

/**
 * Combines facts into one. The merged fact is saved first (in their scope, pinned if any of
 * them was, with the newest one's time and source, credited to whoever saved them all or else
 * the caller), then the originals are removed, so nothing is lost if a step fails. All must be
 * in one scope and each one the caller may change (documentToModify). Returns null, changing
 * nothing, when any of them is gone.
 */
/**
 * What these facts were, for saving them again on Undo, after checking each is still there and
 * the caller may change it (documentToModify). Null when any is gone.
 */
async function originalsOf(tenant: Tenant, parsed: { id: string; scope: Scope; where: Where; documentId: string }[]): Promise<MergedOriginal[] | null> {
  const docs = await Promise.all(parsed.map((p) => documentToModify(tenant, p.where, p.documentId)));
  if (docs.some((d) => !d)) return null;
  return docs.map((doc, i) => {
    const m = toMemory(tenant, parsed[i].where, doc!);
    const createdBy = typeof doc!.metadata?.createdBy === "string" ? doc!.metadata.createdBy : tenant.userId;
    return { id: parsed[i].id, content: m.content, scope: parsed[i].scope, category: m.category, pinned: m.pinned, source: m.source, createdBy, savedAt: m.createdAt };
  });
}

async function deleteParsed(tenant: Tenant, parsed: { where: Where; documentId: string }[]): Promise<void> {
  const byWhere = new Map<Where, string[]>();
  for (const p of parsed) byWhere.set(p.where, [...(byWhere.get(p.where) ?? []), p.documentId]);
  for (const [where, documentIds] of byWhere) await call(tenant, where, "document", { method: "DELETE", body: { ids: documentIds } });
}

/** The most facts one save may replace. */
export const MAX_REPLACED = 6;

/**
 * Saves a fact the agent learned, in place of the facts it says this one updates or restates
 * (`replaces`), so memory keeps one current version instead of growing a copy each time. Only
 * facts in the same scope that the caller may change are replaced; the rest are left alone, and
 * a fact that's gone is skipped. The new fact is saved first (pinned if a replaced one was), then
 * the replaced ones are removed, and they're returned so an Undo can bring them back.
 */
export async function rememberReplacing(
  tenant: Tenant,
  content: string,
  scope: Scope,
  options: RememberOptions & { replaces?: string[] } = {},
): Promise<{ memory: Memory; replaced: MergedOriginal[] }> {
  const candidates = [...new Set(options.replaces ?? [])]
    .slice(0, MAX_REPLACED)
    .flatMap((raw) => {
      // An id without its scope (the agent sometimes drops it) is read as one in this fact's scope.
      const id = parseMemoryId(raw) ? raw : `${scope}:${raw}`;
      const p = parseMemoryId(id);
      return p && p.scope === scope ? [{ id, ...p }] : [];
    });
  const found = await Promise.all(
    candidates.map((p) =>
      originalsOf(tenant, [p]).then(
        (o) => o?.[0] ?? null,
        (error: { status?: number }) => {
          if (error?.status === 403) return null;
          throw error;
        },
      ),
    ),
  );
  const replaced = found.filter((o): o is MergedOriginal => Boolean(o));
  const memory = await remember(tenant, content, scope, {
    ...options,
    category: options.category ?? (replaced.length ? mostCommonCategory(replaced.map((o) => o.category)) : undefined),
    pinned: options.pinned || replaced.some((o) => o.pinned),
  });
  if (replaced.length) await deleteParsed(tenant, candidates.filter((p) => replaced.some((o) => o.id === p.id)));
  return { memory, replaced };
}

/** How many recently saved facts each run lists with their ids, within this much text. */
const RECENT_FACTS = 25;
const RECENT_BUDGET = 4_000;

/**
 * The newest facts the caller may change (their own, or any shared one for an owner), with ids,
 * so the agent can update one with remember's `replaces` instead of saving it again. Never
 * blocks a run: if memory is slow or down, it's empty.
 */
export async function recentMemories(tenant: Tenant): Promise<{ id: string; content: string }[]> {
  if (!memoryEnabled()) return [];
  const wheres: Scope[] = ["workspace", "personal"];
  const lists = await Promise.all(
    wheres.map((where) =>
      listScope(tenant, where, RECENT_FACTS, RECALL_TIMEOUT_MS).catch((error) => {
        console.error("[memory] couldn't list recent facts", error);
        return [] as Memory[];
      }),
    ),
  );
  let used = 0;
  return lists
    .flat()
    .filter((m) => m.mine || tenant.workspace.role === "owner")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, RECENT_FACTS)
    .filter((m) => (used += m.content.length) <= RECENT_BUDGET)
    .map((m) => ({ id: m.id, content: m.content }));
}

export async function mergeMemories(
  tenant: Tenant,
  ids: string[],
  content: string,
  category?: MemoryCategory,
): Promise<{ memory: Memory; originals: MergedOriginal[] } | null> {
  const parsed = [...new Set(ids)].map((id) => ({ id, ...parseMemoryId(id) }));
  if (parsed.length < 2 || parsed.some((p) => !p.where)) fail(400, "Pick at least two facts to merge.");
  const scope = parsed[0].scope!;
  if (parsed.some((p) => p.scope !== scope)) fail(400, "Facts only you see merge only with each other.");
  const valid = parsed as { id: string; scope: Scope; where: Where; documentId: string }[];
  const originals = await originalsOf(tenant, valid);
  if (!originals) return null;
  const newest = [...originals].sort((a, b) => b.savedAt - a.savedAt);
  const authors = new Set(originals.map((o) => o.createdBy));
  const createdBy = authors.size === 1 ? originals[0].createdBy : tenant.userId;
  const memory = await remember(tenant, content, scope, {
    category: category ?? mostCommonCategory(originals.map((o) => o.category)),
    pinned: originals.some((o) => o.pinned),
    source: newest.find((o) => o.source)?.source,
    createdBy,
    savedAt: newest[0].savedAt || undefined,
  });
  await deleteParsed(tenant, valid);
  return { memory: { ...memory, mine: scope === "personal" || createdBy === tenant.userId }, originals };
}

/** The category most of these facts have. */
export function mostCommonCategory(categories: MemoryCategory[]): MemoryCategory {
  const counts = new Map<MemoryCategory, number>();
  for (const c of categories) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other";
}

/**
 * Undoes a merge: saves the facts it replaced again (keeping who saved them, when, and where
 * from), then removes the merged fact. Returns null, changing nothing, when the merged fact is
 * gone (edited or removed since), so an Undo never brings back facts twice. A member who isn't
 * the owner can only restore shared facts as their own.
 */
export async function unmergeMemories(tenant: Tenant, mergedId: string, originals: MergedOriginal[]): Promise<Memory[] | null> {
  const parsed = parseMemoryId(mergedId);
  if (!parsed) return null;
  const doc = await documentToModify(tenant, parsed.where, parsed.documentId);
  if (!doc) return null;
  const restored: Memory[] = [];
  for (const o of originals.filter((o) => o.scope === parsed.scope)) {
    const createdBy = o.scope === "workspace" && tenant.workspace.role !== "owner" ? tenant.userId : o.createdBy;
    const memory = await remember(tenant, o.content, o.scope, {
      category: o.category,
      pinned: o.pinned,
      source: o.source,
      createdBy,
      savedAt: o.savedAt || undefined,
    });
    restored.push({ ...memory, mine: o.scope === "personal" || createdBy === tenant.userId });
  }
  await deleteDocument(tenant, parsed.where, parsed.documentId);
  return restored;
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
 * first. Personal memory not yet moved from this workspace's old namespace is read too, and
 * the move is started.
 */
export async function recall(tenant: Tenant, query?: string, options: { pinned?: boolean } = {}): Promise<string[]> {
  if (!memoryEnabled()) return [];
  const q = query?.replace(/\s+/g, " ").trim().slice(0, 1000);
  const safe = <T>(p: Promise<T>) =>
    p.catch((error) => {
      console.error("[memory] recall failed", error);
      return undefined;
    });
  const wheres: Where[] = moved.has(moveKey(tenant)) ? ["workspace", "personal"] : ["workspace", "personal", "legacy"];
  if (wheres.includes("legacy")) void moveLegacyPersonal(tenant).catch((error) => console.error("[memory] couldn't move personal memories", error));
  const profile = (where: Where) => safe(call<ProfileResponse>(tenant, where, "profile", { method: "POST", body: {} }, RECALL_TIMEOUT_MS));
  const search = (where: Where) =>
    q
      ? safe(call<SearchResponse>(tenant, where, "search", { method: "POST", body: { query: q, searchMode: "memories", limit: 6 } }, RECALL_TIMEOUT_MS))
      : Promise.resolve(undefined);
  const pinned = (where: Where) =>
    options.pinned ? safe(listScope(tenant, where, 100, RECALL_TIMEOUT_MS).then((ms) => ms.filter((m) => m.pinned))) : Promise.resolve(undefined);
  const [profiles, hits, pins] = await Promise.all([
    Promise.all(wheres.map(profile)),
    Promise.all(wheres.map(search)),
    Promise.all(wheres.map(pinned)),
  ]);

  const facts = [
    ...pins.flatMap((p) => (p ?? []).map((m) => m.content)),
    ...hits.flatMap((h) => (h?.results ?? []).map((r) => r.memory)),
    ...profiles.flatMap((p) => (p?.profile?.static ?? []).map((m) => m.memory)),
    ...profiles.flatMap((p) => (p?.profile?.dynamic ?? []).map((m) => m.memory)),
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

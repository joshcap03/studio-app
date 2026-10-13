import { getConfig } from "@/lib/config";
import type { Tenant } from "@/lib/tenant";
import type { Memory } from "@/lib/types";

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
  const text = typeof doc.metadata?.text === "string" ? doc.metadata.text : (doc.content ?? doc.summary ?? doc.title ?? "");
  return {
    id: `${scope}:${doc.id}`,
    content: text,
    scope,
    createdAt: Date.parse(doc.system?.createdAt ?? "") || 0,
    mine: scope === "personal" || doc.metadata?.createdBy === tenant.userId,
  };
}

/** Saves one fact. `instant` processing makes it recallable on the very next message. */
export async function remember(tenant: Tenant, content: string, scope: Scope): Promise<Memory> {
  const text = content.replace(/\s+/g, " ").trim();
  const metadata = { source: "studio", text, createdBy: tenant.userId };
  const doc = await call<{ id: string }>(tenant, scope, "document", {
    method: "POST",
    body: { content: text, metadata, dreaming: "instant" },
  });
  return { id: `${scope}:${doc.id}`, content: text, scope, createdAt: Date.now(), mine: true };
}

/** What this member can see: the workspace's shared memory and their own. */
export async function listMemories(tenant: Tenant, limit = 100): Promise<Memory[]> {
  const list = (scope: Scope) =>
    call<{ documents?: DocumentRow[] }>(tenant, scope, `list/documents?limit=${limit}&sort=createdAt&order=desc`, {
      method: "POST",
      body: {},
    }).then((r) => (r.documents ?? []).map((d) => toMemory(tenant, scope, d)).filter((m) => m.content));
  const [shared, personal] = await Promise.all([list("workspace"), list("personal")]);
  return [...shared, ...personal].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Removes a memory and everything Supermemory learned from it. Personal memories are the
 * member's own; a shared one can be removed by whoever saved it or a workspace owner.
 */
export async function forget(tenant: Tenant, id: string): Promise<boolean> {
  const parsed = parseMemoryId(id);
  if (!parsed) return false;
  if (parsed.scope === "workspace" && tenant.workspace.role !== "owner") {
    const doc = await call<DocumentRow>(tenant, "workspace", `document/${encodeURIComponent(parsed.documentId)}`, { method: "GET" }).catch(
      (error: { status?: number }) => {
        if (error?.status === 404) return null;
        throw error;
      },
    );
    if (!doc) return false;
    if (doc.metadata?.createdBy !== tenant.userId) {
      throw Object.assign(new Error("Only the person who saved this or a workspace owner can remove it."), { status: 403 });
    }
  }
  const result = await call<{ count: number }>(tenant, parsed.scope, "document", { method: "DELETE", body: { ids: [parsed.documentId] } });
  return result.count > 0;
}

interface ProfileResponse {
  profile?: { static?: { memory: string }[]; dynamic?: { memory: string }[] };
}
interface SearchResponse {
  results?: { memory?: string; chunk?: string }[];
}

/**
 * What the agent should know going into a reply: the standing profile of the business and
 * of this member, plus anything that matches the message. Never blocks the reply: if memory
 * is slow or down, the agent answers without it.
 */
export async function recall(tenant: Tenant, query?: string): Promise<string[]> {
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
  const [sharedProfile, personalProfile, sharedHits, personalHits] = await Promise.all([
    profile("workspace"),
    profile("personal"),
    search("workspace"),
    search("personal"),
  ]);

  const facts = [
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

import { getMemory, mergeMemories, mostCommonCategory, parseMemoryId, unmergeMemories } from "@/lib/memory";
import type { Tenant } from "@/lib/tenant-core";
import {
  MEMORY_CATEGORIES,
  type AppliedMerge,
  type Memory,
  type MemoryCategory,
  type MemoryMerge,
  type MemoryMergeProposal,
  type UiResponse,
} from "@/lib/types";

// Tidying the Brain: the agent proposes combining overlapping facts (its merge_memories tool,
// usually from the "Tidy up" skill), the app checks the proposal against what memory holds and
// shows it as a card, and only the member's click merges them, under their session, with an
// Undo. The agent names facts only by the ids it was given; whose facts they are, and whether
// the member may change them, is decided here.

export const MAX_MERGES = 8;
/** The most facts one merge may replace. */
export const MAX_MERGED = 12;
export const MAX_MERGE_TEXT = 500;

export interface MergeRequest {
  summary: string;
  merges: { text: string; category?: MemoryCategory; replaces: string[] }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const line = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * Validates what the agent sent: each merge needs text and at least two well-formed fact ids,
 * and a fact goes in one merge at most (a later merge naming it again loses it). Anything
 * unusable is dropped. Null when no merge is left.
 */
export function parseMergeRequest(raw: unknown): MergeRequest | null {
  const body = isRecord(raw) && isRecord(raw.memory_merge) ? raw.memory_merge : raw;
  if (!isRecord(body) || !Array.isArray(body.merges)) return null;
  const claimed = new Set<string>();
  const merges: MergeRequest["merges"] = [];
  for (const m of body.merges) {
    if (!isRecord(m)) continue;
    const text = line(m.text ?? m.content, MAX_MERGE_TEXT);
    const ids = Array.isArray(m.replaces) ? m.replaces : Array.isArray(m.ids) ? m.ids : [];
    const replaces = [...new Set(ids.map((id) => line(id, 300).replace(/^\[|\]$/g, "")))].filter((id) => parseMemoryId(id) && !claimed.has(id));
    if (!text || replaces.length < 2) continue;
    for (const id of replaces.slice(0, MAX_MERGED)) claimed.add(id);
    const category = MEMORY_CATEGORIES.find((c) => c === m.category);
    merges.push({ text, ...(category ? { category } : {}), replaces: replaces.slice(0, MAX_MERGED) });
    if (merges.length === MAX_MERGES) break;
  }
  return merges.length ? { summary: line(body.summary, 600), merges } : null;
}

/**
 * Turns the agent's request into the card the member sees: each fact it names is looked up
 * under the member's session, and only facts that exist and that they may change are kept
 * (their own, or any shared one for an owner). A merge left with fewer than two facts, or
 * mixing shared facts with ones only they see, is dropped. Null when nothing is left.
 */
export async function resolveMergeProposal(tenant: Tenant, raw: unknown, id: string = crypto.randomUUID()): Promise<MemoryMergeProposal | null> {
  const request = parseMergeRequest(raw);
  if (!request) return null;
  const ids = [...new Set(request.merges.flatMap((m) => m.replaces))];
  const found = await Promise.all(ids.map((i) => getMemory(tenant, i).catch(() => null)));
  const memories = new Map<string, Memory>();
  ids.forEach((i, n) => {
    const memory = found[n];
    if (memory && (memory.mine || tenant.workspace.role === "owner")) memories.set(i, memory);
  });
  const merges: MemoryMerge[] = [];
  for (const m of request.merges) {
    const originals = m.replaces.flatMap((i) => memories.get(i) ?? []);
    if (originals.length < 2 || originals.some((o) => o.scope !== originals[0].scope)) continue;
    merges.push({
      text: m.text,
      category: m.category ?? mostCommonCategory(originals.map((o) => o.category)),
      scope: originals[0].scope,
      pinned: originals.some((o) => o.pinned),
      originals: originals.map((o) => ({ id: o.id, content: o.content, pinned: o.pinned })),
    });
  }
  return merges.length ? { kind: "memory-merge", id, summary: request.summary, merges } : null;
}

type Merged = Extract<UiResponse, { status: "merged" }>;
type Undone = Extract<UiResponse, { status: "undone" }>;

/**
 * Makes the merges the member picked, from the stored proposal (with their own edits to the
 * merged texts). Each is checked again against memory as it is now: a merge whose facts are gone
 * or no longer theirs to change is skipped, not half made. Throws only when every picked merge
 * failed for another reason (memory down), so the member can try again.
 */
export async function applyMerges(
  tenant: Tenant,
  proposal: MemoryMergeProposal,
  picks: number[],
  edits: Record<string, string>,
): Promise<Omit<Merged, "status" | "at">> {
  const indexes = [...new Set(picks)].filter((i) => i >= 0 && i < proposal.merges.length).sort((a, b) => a - b);
  const merges: AppliedMerge[] = [];
  let failure: unknown = null;
  for (const index of indexes) {
    const merge = proposal.merges[index];
    const text = line(edits[String(index)] ?? merge.text, MAX_MERGE_TEXT) || merge.text;
    try {
      const result = await mergeMemories(
        tenant,
        merge.originals.map((o) => o.id),
        text,
        merge.category,
      );
      if (result) merges.push({ index, memoryId: result.memory.id, text: result.memory.content, originals: result.originals });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 403 && status !== 400) {
        console.error("[memory] couldn't merge facts", error);
        failure = error;
      }
    }
  }
  if (merges.length === 0 && failure) throw failure;
  return { merges, skipped: indexes.length - merges.length };
}

/** Undoes the merges a card made: each merged fact still there goes, and its originals come back. */
export async function undoMerges(tenant: Tenant, merged: Merged): Promise<Omit<Undone, "status" | "at">> {
  let restored = 0;
  let skipped = 0;
  for (const merge of merged.merges) {
    const back = await unmergeMemories(tenant, merge.memoryId, merge.originals).catch((error: { status?: number }) => {
      if (error?.status === 403 || error?.status === 404) return null;
      throw error;
    });
    if (back) restored += back.length;
    else skipped += 1;
  }
  return { restored, skipped, merges: merged.merges.map(({ index, text }) => ({ index, text })) };
}

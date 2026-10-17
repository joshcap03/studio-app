import { forget, getMemory, listMemories, parseMemoryId, remember } from "@/lib/memory";
import type { Tenant } from "@/lib/tenant-core";
import { toMemoryCategory, type Memory, type MemoryPromotion } from "@/lib/types";

// Business Brain's review queue: a member asks for a personal memory to be shared with the
// workspace, and an owner decides. Rows go through the tenant's RLS-bound client (members
// see their own requests, owners see the workspace's); the database also refuses decisions
// from anyone but an owner.

interface PromotionRow {
  id: string;
  requested_by: string;
  personal_doc_id: string;
  content: string;
  category: string;
  status: MemoryPromotion["status"];
  created_at: string;
}

const COLUMNS = "id, requested_by, personal_doc_id, content, category, status, created_at";

function check<T>(result: { data: T; error: { message: string; code?: string } | null }): T {
  if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.data;
}

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

const toPromotion = (tenant: Tenant, r: PromotionRow): MemoryPromotion => ({
  id: r.id,
  memoryId: `personal:${r.personal_doc_id}`,
  content: r.content,
  category: toMemoryCategory(r.category),
  status: r.status,
  mine: r.requested_by === tenant.userId,
  createdAt: Date.parse(r.created_at),
});

/** Pending requests the caller can see: their own, plus everyone's for an owner. */
export async function listPromotions(tenant: Tenant): Promise<MemoryPromotion[]> {
  const rows = check(
    await tenant.db
      .from("memory_promotions")
      .select(COLUMNS)
      .eq("workspace_id", tenant.workspace.id)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(100)
      .returns<PromotionRow[]>(),
  );
  return (rows ?? []).map((r) => toPromotion(tenant, r));
}

/** Asks to share a personal memory. An owner's own request is approved straight away. */
export async function requestPromotion(tenant: Tenant, memoryId: string): Promise<MemoryPromotion> {
  const parsed = parseMemoryId(memoryId);
  if (!parsed || parsed.scope !== "personal") fail(400, "Only your own memories can be shared.");
  const memory = await getMemory(tenant, memoryId);
  if (!memory) fail(404, "Memory not found.");
  const result = await tenant.db
    .from("memory_promotions")
    .insert({
      workspace_id: tenant.workspace.id,
      requested_by: tenant.userId,
      personal_doc_id: parsed.documentId,
      content: memory.content,
      category: memory.category,
    })
    .select(COLUMNS)
    .single<PromotionRow>();
  if (result.error?.code === "23505") fail(409, "This is already waiting for the owner.");
  const promotion = toPromotion(tenant, check(result)!);
  if (tenant.workspace.role === "owner") return decidePromotion(tenant, promotion.id, "approve");
  return promotion;
}

/** An owner approves (the fact becomes shared, credited to the requester) or rejects. */
export async function decidePromotion(tenant: Tenant, id: string, decision: "approve" | "reject"): Promise<MemoryPromotion> {
  if (tenant.workspace.role !== "owner") fail(403, "Only the workspace owner can decide on shared memories.");
  const row = check(
    await tenant.db
      .from("memory_promotions")
      .select(COLUMNS)
      .eq("workspace_id", tenant.workspace.id)
      .eq("id", id)
      .maybeSingle<PromotionRow>(),
  );
  if (!row) fail(404, "Request not found.");
  if (row.status !== "pending") fail(409, "This has already been decided.");
  if (decision === "approve") {
    await remember(tenant, row.content, "workspace", { category: toMemoryCategory(row.category), createdBy: row.requested_by });
  }
  const updated = check(
    await tenant.db
      .from("memory_promotions")
      .update({ status: decision === "approve" ? "approved" : "rejected", decided_by: tenant.userId, decided_at: new Date().toISOString() })
      .eq("workspace_id", tenant.workspace.id)
      .eq("id", id)
      .select(COLUMNS)
      .single<PromotionRow>(),
  )!;
  return toPromotion(tenant, updated);
}

/**
 * Removes the caller's personal copies of facts an owner has since shared. An owner can't
 * reach a member's personal memory, so the member's own session does it the next time they
 * look. Returns the personal memory ids it removed.
 */
export async function cleanUpPromoted(tenant: Tenant): Promise<string[]> {
  const rows = check(
    await tenant.db
      .from("memory_promotions")
      .select(COLUMNS)
      .eq("workspace_id", tenant.workspace.id)
      .eq("requested_by", tenant.userId)
      .eq("status", "approved")
      .eq("cleaned", false)
      .limit(50)
      .returns<PromotionRow[]>(),
  );
  const removed: string[] = [];
  for (const row of rows ?? []) {
    const memoryId = `personal:${row.personal_doc_id}`;
    try {
      // Already gone (removed by hand) counts as cleaned up.
      await forget(tenant, memoryId).catch((error: { status?: number }) => {
        if (error?.status !== 404) throw error;
      });
      check(await tenant.db.from("memory_promotions").update({ cleaned: true }).eq("id", row.id));
      removed.push(memoryId);
    } catch (error) {
      console.error("[brain] couldn't remove a shared memory's personal copy", error);
    }
  }
  return removed;
}

/** The memories Business Brain shows, after removing personal copies of shared facts. */
export async function brainMemories(tenant: Tenant): Promise<Memory[]> {
  const removed = new Set(await cleanUpPromoted(tenant).catch(() => []));
  return (await listMemories(tenant)).filter((m) => !removed.has(m.id));
}

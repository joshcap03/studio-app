import type { Tenant } from "@/lib/tenant-core";
import { MAX_SKILLS, type WorkspaceSkill } from "@/lib/types";
import { builtinSkill } from "./builtin";
import { catalogEntry } from "./catalog";
import { SETUP_SKILL_ID, setupSkill } from "./setup";

// A workspace's skills. Reads and writes go through the tenant's RLS-bound client, filtered
// by the tenant's workspace; the database also refuses writes from anyone but an owner.

interface SkillRow {
  id: string;
  catalog_id: string | null;
  name: string;
  description: string;
  instructions: string;
  created_at: string;
}

const COLUMNS = "id, catalog_id, name, description, instructions, created_at";

function check<T>(result: { data: T; error: { message: string; code?: string } | null }): T {
  if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.data;
}

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function requireOwner(tenant: Tenant) {
  if (tenant.workspace.role !== "owner") fail(403, "Only the owner can change skills.");
}

const toSkill = (r: SkillRow): WorkspaceSkill => ({
  id: r.id,
  catalogId: r.catalog_id,
  name: r.name,
  description: r.description,
  instructions: r.instructions,
  createdAt: Date.parse(r.created_at),
});

export async function listSkills(tenant: Tenant): Promise<WorkspaceSkill[]> {
  const rows = check(
    await tenant.db
      .from("workspace_skills")
      .select(COLUMNS)
      .eq("workspace_id", tenant.workspace.id)
      .order("created_at", { ascending: true })
      .limit(MAX_SKILLS),
  ) as SkillRow[];
  return rows.map(toSkill);
}

/** One of the workspace's skills, by id; the setup skill as said on a call when `call`. */
export async function getSkill(tenant: Tenant, id: string, { call = false }: { call?: boolean } = {}): Promise<WorkspaceSkill | null> {
  if (id === SETUP_SKILL_ID) {
    // Every agent has its setup interview, with steps from the template it started from.
    const row = check(
      await tenant.db.from("workspace_settings").select("template_id").eq("workspace_id", tenant.workspace.id).maybeSingle(),
    ) as { template_id: string | null } | null;
    return setupSkill(row?.template_id, { call });
  }
  if (id.startsWith("builtin:")) return builtinSkill(tenant, id);
  const row = check(
    await tenant.db.from("workspace_skills").select(COLUMNS).eq("id", id).eq("workspace_id", tenant.workspace.id).maybeSingle(),
  ) as SkillRow | null;
  return row ? toSkill(row) : null;
}

export interface SkillDraft {
  name: string;
  description: string;
  instructions: string;
}

async function insert(tenant: Tenant, draft: SkillDraft, catalogId: string | null): Promise<WorkspaceSkill> {
  requireOwner(tenant);
  const { count, error } = await tenant.db
    .from("workspace_skills")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", tenant.workspace.id);
  if (error) throw new Error(error.message);
  if ((count ?? 0) >= MAX_SKILLS) fail(409, `An agent can hold up to ${MAX_SKILLS} skills. Remove some first.`);
  const result = await tenant.db
    .from("workspace_skills")
    .insert({ workspace_id: tenant.workspace.id, catalog_id: catalogId, created_by: tenant.userId, ...draft })
    .select(COLUMNS)
    .single();
  if (result.error?.code === "23505") fail(409, "That skill is already in this agent.");
  return toSkill(check(result) as SkillRow);
}

export function createSkill(tenant: Tenant, draft: SkillDraft): Promise<WorkspaceSkill> {
  return insert(tenant, draft, null);
}

/** Copies a library entry into the workspace, where the owner can adapt it. */
export async function addFromCatalog(tenant: Tenant, catalogId: string): Promise<WorkspaceSkill> {
  const entry = catalogEntry(catalogId);
  if (!entry) fail(404, "That library entry doesn't exist.");
  return insert(tenant, { name: entry.name, description: entry.description, instructions: entry.instructions }, entry.id);
}

export async function updateSkill(tenant: Tenant, id: string, patch: Partial<SkillDraft>): Promise<WorkspaceSkill | null> {
  requireOwner(tenant);
  const rows = check(
    await tenant.db
      .from("workspace_skills")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", tenant.workspace.id)
      .select(COLUMNS),
  ) as SkillRow[];
  return rows[0] ? toSkill(rows[0]) : null;
}

export async function deleteSkill(tenant: Tenant, id: string): Promise<boolean> {
  requireOwner(tenant);
  const rows = check(
    await tenant.db.from("workspace_skills").delete().eq("id", id).eq("workspace_id", tenant.workspace.id).select("id"),
  ) as { id: string }[];
  return rows.length > 0;
}

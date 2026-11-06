import type { Tenant } from "@/lib/tenant-core";
import { MAX_SKILLS } from "@/lib/types";

// What an agent's brief and skills were before each change (`agent_revisions`). Database triggers
// write it, so every path that changes them is covered; this only reads it and puts a part back
// (`restore_agent_revision`, which records what it replaces, so a restore can be undone too).
// The owner's, like the things it records.

export type RevisionPart = "profile" | "instructions" | "skill";

export interface SkillVersion {
  name: string;
  description: string;
  instructions: string;
}

export interface AgentRevision {
  id: string;
  part: RevisionPart;
  skillId: string | null;
  /** A skill as it was when it was deleted. */
  deleted: boolean;
  /** The brief part's text before the change. */
  text: string | null;
  /** The skill before the change. */
  skill: SkillVersion | null;
  /** Whether the person looking made the change; nothing more is known about who, so nothing more is said. */
  mine: boolean;
  createdAt: number;
}

interface Row {
  id: string;
  part: RevisionPart;
  skill_id: string | null;
  deleted: boolean;
  previous: { text?: string | null; name?: string; description?: string; instructions?: string };
  author: string | null;
  created_at: string;
}

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function requireOwner(tenant: Tenant) {
  if (tenant.workspace.role !== "owner") fail(403, "Only the owner can see or restore history.");
}

const HISTORY_ROWS = 100;

export async function listRevisions(tenant: Tenant): Promise<AgentRevision[]> {
  requireOwner(tenant);
  const { data, error } = await tenant.db
    .from("agent_revisions")
    .select("id, part, skill_id, deleted, previous, author, created_at")
    .eq("workspace_id", tenant.workspace.id)
    .order("created_at", { ascending: false })
    .limit(HISTORY_ROWS)
    .returns<Row[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id,
    part: r.part,
    skillId: r.skill_id,
    deleted: r.deleted,
    text: r.part === "skill" ? null : (r.previous.text ?? null),
    skill: r.part === "skill" ? { name: r.previous.name ?? "", description: r.previous.description ?? "", instructions: r.previous.instructions ?? "" } : null,
    mine: r.author === tenant.userId,
    createdAt: Date.parse(r.created_at),
  }));
}

export async function restoreRevision(tenant: Tenant, id: string): Promise<boolean> {
  requireOwner(tenant);
  const { data: revision, error: readError } = await tenant.db
    .from("agent_revisions")
    .select("part, skill_id")
    .eq("id", id)
    .eq("workspace_id", tenant.workspace.id)
    .maybeSingle<{ part: RevisionPart; skill_id: string | null }>();
  if (readError) throw new Error(readError.message);
  if (!revision) return false;
  if (revision.skill_id) {
    // Bringing a deleted skill back is adding one, under the same limit.
    const { data: here } = await tenant.db.from("workspace_skills").select("id").eq("id", revision.skill_id).eq("workspace_id", tenant.workspace.id).maybeSingle();
    if (!here) {
      const { count, error } = await tenant.db.from("workspace_skills").select("id", { count: "exact", head: true }).eq("workspace_id", tenant.workspace.id);
      if (error) throw new Error(error.message);
      if ((count ?? 0) >= MAX_SKILLS) fail(400, `This agent is at its limit of ${MAX_SKILLS} skills. Remove one first.`);
    }
  }
  const { error } = await tenant.db.rpc("restore_agent_revision", { revision: id });
  if (error) throw new Error(error.message);
  return true;
}

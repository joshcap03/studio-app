import { ATTACHMENTS_BUCKET } from "@/lib/attachments";
import { forgetAgent } from "@/lib/memory";
import { agentTriggers, dropTrigger } from "@/lib/tasks/watches";
import type { Tenant } from "@/lib/tenant-core";

/**
 * Deletes an agent its owner picked (`tenant` is resolved to that agent). The database takes
 * its chats, tasks, skills, Library, and settings with it. What lives outside the database goes
 * after the row, best effort, so a failure there never leaves a half-deleted agent: the owner's
 * watch triggers in Composio, the agent's memory in Supermemory, and the owner's files in Storage.
 */
export async function deleteAgent(tenant: Tenant): Promise<void> {
  if (tenant.workspace.role !== "owner") throw Object.assign(new Error("Only the agent's owner can delete it."), { status: 403 });
  const [triggers, paths] = await Promise.all([agentTriggers(tenant), storedPaths(tenant)]);

  const { data, error } = await tenant.db.from("workspaces").delete().eq("id", tenant.workspace.id).select("id");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw Object.assign(new Error("Agent not found."), { status: 404 });

  const cleanup = [
    ...triggers.map((id) => dropTrigger(tenant, id)),
    forgetAgent(tenant),
    paths.length > 0 ? removeFiles(tenant, paths) : Promise.resolve(),
  ];
  for (const result of await Promise.allSettled(cleanup)) {
    if (result.status === "rejected") console.error("[agents] cleanup after delete failed", result.reason);
  }
}

/** The owner's files kept for this agent: message attachments, project files, and agent files. */
async function storedPaths(tenant: Tenant): Promise<string[]> {
  const tables = ["attachments", "project_files", "agent_files"] as const;
  const results = await Promise.all(
    tables.map((table) => tenant.db.from(table).select("storage_path").eq("workspace_id", tenant.workspace.id).eq("user_id", tenant.userId)),
  );
  return results.flatMap(({ data, error }) => {
    if (error) throw new Error(error.message);
    return ((data ?? []) as { storage_path: string }[]).map((r) => r.storage_path);
  });
}

async function removeFiles(tenant: Tenant, paths: string[]): Promise<void> {
  // Storage removes up to 1,000 objects a call.
  for (let i = 0; i < paths.length; i += 1000) {
    const { error } = await tenant.db.storage.from(ATTACHMENTS_BUCKET).remove(paths.slice(i, i + 1000));
    if (error) throw new Error(error.message);
  }
}

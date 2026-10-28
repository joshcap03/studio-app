import type { SentFile } from "@/lib/agent/types";
import type { Tenant } from "@/lib/tenant-core";

// Where the agent service already has one of the member's standing files (see the sent_files
// migration): read with the file and kept up to date by the adapter after an upload, under the
// member's own session, so the next run reuses the copy instead of uploading it again.

export const SENT_COLUMNS = "sent_to, sent_id, sent_path";

export interface SentRow {
  sent_to: string | null;
  sent_id: string | null;
  sent_path: string | null;
}

/** The copy the service has, as stored, or null when there's none on record. */
export function sentOf(row: SentRow): SentFile | null {
  return row.sent_to && row.sent_id && row.sent_path ? { to: row.sent_to, id: row.sent_id, path: row.sent_path } : null;
}

/** Records where the service has the file now. Best effort: a run goes on without it. */
export async function rememberSent(tenant: Tenant, table: "agent_files" | "project_files", fileId: string, sent: SentFile): Promise<void> {
  const { error } = await tenant.db
    .from(table)
    .update({ sent_to: sent.to, sent_id: sent.id, sent_path: sent.path, sent_at: new Date().toISOString() })
    .eq("id", fileId)
    .eq("workspace_id", tenant.workspace.id)
    .eq("user_id", tenant.userId);
  if (error) throw new Error(error.message);
}

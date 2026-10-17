import type { AgentAttachment } from "@/lib/agent/types";
import { ATTACHMENTS_BUCKET, attachmentError, checkUpload, readAttachment, removeAttachmentFiles, uploadError } from "@/lib/attachments";
import type { StoredAttachment } from "@/lib/db/store";
import type { Tenant } from "@/lib/tenant-core";
import { MAX_AGENT_FILES, MAX_RUN_FILES, type Attachment } from "@/lib/types";

// A member's files for one agent (a résumé, a price list): the agent gets them on every run,
// in every conversation. Private to the member, like their projects: every query is filtered
// by the tenant's workspace and user, and RLS enforces the same. Bytes live in the member's
// own folder of the attachments bucket.

interface FileRow {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  storage_path: string;
}

const FILE_COLUMNS = "id, name, mime_type, size, storage_path";

const toFile = (r: FileRow): StoredAttachment => ({
  id: r.id,
  name: r.name,
  mimeType: r.mime_type,
  size: r.size,
  storagePath: r.storage_path,
});
const publicFile = ({ storagePath: _, ...file }: StoredAttachment): Attachment => file;

const files = (tenant: Tenant) => tenant.db.from("agent_files");

const fullError = () => attachmentError(`This agent can hold up to ${MAX_AGENT_FILES} files. Remove some first.`, 409);
/** The database's own cap (see the agent_files migration), as an error the member can act on. */
const capped = (error: { message: string; hint?: string }) => error.hint === "agent_files_cap" || /agent files limit/.test(error.message);

async function storedFiles(tenant: Tenant): Promise<StoredAttachment[]> {
  const { data, error } = await files(tenant)
    .select(FILE_COLUMNS)
    .eq("workspace_id", tenant.workspace.id)
    .eq("user_id", tenant.userId)
    .order("created_at", { ascending: true })
    .limit(MAX_AGENT_FILES);
  if (error) throw new Error(error.message);
  return (data as FileRow[]).map(toFile);
}

export async function listAgentFiles(tenant: Tenant): Promise<Attachment[]> {
  return (await storedFiles(tenant)).map(publicFile);
}

export async function addAgentFile(tenant: Tenant, file: File): Promise<Attachment> {
  const { name, mimeType } = checkUpload(file);
  const { count, error: countError } = await files(tenant)
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", tenant.workspace.id)
    .eq("user_id", tenant.userId);
  if (countError) throw new Error(countError.message);
  if ((count ?? 0) >= MAX_AGENT_FILES) throw fullError();

  const path = `${tenant.workspace.id}/${tenant.userId}/agent/${crypto.randomUUID()}/${name}`;
  const storage = tenant.db.storage.from(ATTACHMENTS_BUCKET);
  const uploaded = await storage.upload(path, new Blob([file], { type: mimeType }), { contentType: mimeType, upsert: false });
  if (uploaded.error) throw uploadError(uploaded.error);

  const { data, error } = await files(tenant)
    .insert({ workspace_id: tenant.workspace.id, user_id: tenant.userId, name, mime_type: mimeType, size: file.size, storage_path: path })
    .select(FILE_COLUMNS)
    .single();
  if (error || !data) {
    await storage.remove([path]);
    if (error && capped(error)) throw fullError();
    throw new Error(`Database error: ${error?.message ?? "no row"}`);
  }
  return publicFile(toFile(data as FileRow));
}

/**
 * Moves a file the member already uploaded (and hasn't sent with a message) onto this agent's
 * shelf, keeping its id and bytes. After this it's an agent file, not an attachment: don't
 * also send it with a message. Null when there's no such unsent file of theirs.
 */
export async function claimAsAgentFile(tenant: Tenant, attachmentId: string): Promise<Attachment | null> {
  const { data: id, error } = await tenant.db.rpc("claim_agent_file", { p_attachment: attachmentId, p_workspace: tenant.workspace.id });
  if (error) {
    if (capped(error)) throw fullError();
    throw new Error(`Database error: ${error.message}`);
  }
  if (!id) return null;
  const { data, error: readError } = await files(tenant)
    .select(FILE_COLUMNS)
    .eq("id", id as string)
    .eq("workspace_id", tenant.workspace.id)
    .eq("user_id", tenant.userId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  return data ? publicFile(toFile(data as FileRow)) : null;
}

export async function removeAgentFile(tenant: Tenant, fileId: string): Promise<boolean> {
  const { data, error } = await files(tenant)
    .delete()
    .eq("id", fileId)
    .eq("workspace_id", tenant.workspace.id)
    .eq("user_id", tenant.userId)
    .select("storage_path");
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { storage_path: string }[];
  await removeAttachmentFiles(
    tenant,
    rows.map((r) => r.storage_path),
  );
  return rows.length > 0;
}

/** This agent's files as a run gets them, when the agent can read files. */
export async function agentFilesForRun(tenant: Tenant, readsFiles: boolean): Promise<AgentAttachment[]> {
  if (!readsFiles) return [];
  return (await storedFiles(tenant)).map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size,
    read: () => readAttachment(tenant, f),
  }));
}

/**
 * The standing files one run carries: the agent's own first, then the project's, without the
 * same file twice (by id, or by name and size when it sits on both shelves), up to the cap.
 */
export function runFiles(agentFiles: AgentAttachment[], projectFiles: AgentAttachment[], cap = MAX_RUN_FILES): AgentAttachment[] {
  const seen = new Set<string>();
  const out: AgentAttachment[] = [];
  for (const file of [...agentFiles, ...projectFiles]) {
    const keys = [`id:${file.id}`, `file:${file.name}:${file.size}`];
    if (keys.some((k) => seen.has(k))) continue;
    if (out.length >= cap) break;
    keys.forEach((k) => seen.add(k));
    out.push(file);
  }
  return out;
}

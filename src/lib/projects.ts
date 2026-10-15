import { getAgentAdapter } from "@/lib/agent";
import type { AgentAttachment, AgentTenantContext } from "@/lib/agent/types";
import { ATTACHMENTS_BUCKET, attachmentError, checkUpload, readAttachment, removeAttachmentFiles, uploadError } from "@/lib/attachments";
import { storeFor } from "@/lib/chat/store-for";
import type { StoredAttachment } from "@/lib/db/store";
import type { Tenant } from "@/lib/tenant";
import { MAX_PROJECT_FILES, MAX_PROJECTS, type Attachment, type Project, type ProjectSummary } from "@/lib/types";

// A member's projects: folders of conversations with instructions and files the agent gets on
// every run in them. Private to the member, like their conversations: every query is filtered
// by the tenant's workspace and user, and RLS enforces the same. File bytes live in the
// member's own folder of the attachments bucket.

interface ProjectRow {
  id: string;
  name: string;
  instructions: string;
  created_at: string;
  updated_at: string;
}

interface FileRow {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  storage_path: string;
}

const COLUMNS = "id, name, instructions, created_at, updated_at";
const FILE_COLUMNS = "id, name, mime_type, size, storage_path";

function check<T>(result: { data: T; error: { message: string; code?: string } | null }): T {
  if (result.error)
    throw Object.assign(new Error(result.error.message), {
      code: result.error.code,
    });
  return result.data;
}

const toSummary = (r: ProjectRow): ProjectSummary => ({
  id: r.id,
  name: r.name,
  createdAt: Date.parse(r.created_at),
  updatedAt: Date.parse(r.updated_at),
});

const toFile = (r: FileRow): StoredAttachment => ({
  id: r.id,
  name: r.name,
  mimeType: r.mime_type,
  size: r.size,
  storagePath: r.storage_path,
});
const publicFile = ({ storagePath: _, ...file }: StoredAttachment): Attachment => file;

const projects = (tenant: Tenant) => tenant.db.from("projects");
const files = (tenant: Tenant) => tenant.db.from("project_files");

export async function listProjects(tenant: Tenant): Promise<ProjectSummary[]> {
  const rows = check(
    await projects(tenant)
      .select(COLUMNS)
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId)
      .order("updated_at", { ascending: false })
      .limit(MAX_PROJECTS),
  ) as ProjectRow[];
  return rows.map(toSummary);
}

async function projectRow(tenant: Tenant, id: string): Promise<ProjectRow | null> {
  return check(
    await projects(tenant).select(COLUMNS).eq("id", id).eq("workspace_id", tenant.workspace.id).eq("user_id", tenant.userId).maybeSingle(),
  ) as ProjectRow | null;
}

async function storedFiles(tenant: Tenant, projectId: string): Promise<StoredAttachment[]> {
  const rows = check(
    await files(tenant)
      .select(FILE_COLUMNS)
      .eq("project_id", projectId)
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId)
      .order("created_at", { ascending: true }),
  ) as FileRow[];
  return rows.map(toFile);
}

export async function getProject(tenant: Tenant, id: string): Promise<Project | null> {
  const row = await projectRow(tenant, id);
  if (!row) return null;
  return {
    ...toSummary(row),
    instructions: row.instructions,
    files: (await storedFiles(tenant, id)).map(publicFile),
  };
}

export async function createProject(tenant: Tenant, input: { name: string; instructions?: string }): Promise<Project> {
  const { count, error } = await projects(tenant)
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", tenant.workspace.id)
    .eq("user_id", tenant.userId);
  if (error) throw new Error(error.message);
  if ((count ?? 0) >= MAX_PROJECTS)
    throw Object.assign(new Error(`You can have up to ${MAX_PROJECTS} projects. Delete some first.`), { status: 409 });
  const row = check(
    await projects(tenant)
      .insert({
        workspace_id: tenant.workspace.id,
        user_id: tenant.userId,
        name: input.name,
        instructions: input.instructions ?? "",
      })
      .select(COLUMNS)
      .single(),
  ) as ProjectRow;
  return { ...toSummary(row), instructions: row.instructions, files: [] };
}

export async function updateProject(tenant: Tenant, id: string, patch: { name?: string; instructions?: string }): Promise<Project | null> {
  const row = check(
    await projects(tenant)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId)
      .select(COLUMNS)
      .maybeSingle(),
  ) as ProjectRow | null;
  if (!row) return null;
  return {
    ...toSummary(row),
    instructions: row.instructions,
    files: (await storedFiles(tenant, id)).map(publicFile),
  };
}

/** Deletes a project with its conversations and files, and removes their stored bytes. */
export async function deleteProject(tenant: Tenant, id: string): Promise<boolean> {
  if (!(await projectRow(tenant, id))) return false;
  const store = storeFor(tenant);
  const conversations = await store.listProjectConversations(id);
  const [projectFiles, perConversation] = await Promise.all([
    storedFiles(tenant, id),
    Promise.all(
      conversations.map(async (c) => ({
        paths: await store.attachmentPaths(c.id),
        pending: await store.pendingApproval(c.id),
      })),
    ),
  ]);
  const deleted = check(
    await projects(tenant).delete().eq("id", id).eq("workspace_id", tenant.workspace.id).eq("user_id", tenant.userId).select("id"),
  ) as { id: string }[];
  if (deleted.length === 0) return false;
  await removeAttachmentFiles(tenant, [...projectFiles.map((f) => f.storagePath), ...perConversation.flatMap((c) => c.paths)]);
  const adapter = getAgentAdapter();
  for (const { pending } of perConversation) {
    if (pending && pending.provider === adapter.id) await adapter.discard?.(pending.providerState).catch(() => undefined);
  }
  return true;
}

export async function addProjectFile(tenant: Tenant, projectId: string, file: File): Promise<Attachment | null> {
  const { name, mimeType } = checkUpload(file);
  if (!(await projectRow(tenant, projectId))) return null;
  const { count, error: countError } = await files(tenant)
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("workspace_id", tenant.workspace.id)
    .eq("user_id", tenant.userId);
  if (countError) throw new Error(countError.message);
  if ((count ?? 0) >= MAX_PROJECT_FILES)
    throw attachmentError(`A project can hold up to ${MAX_PROJECT_FILES} files. Remove some first.`, 409);

  const path = `${tenant.workspace.id}/${tenant.userId}/projects/${projectId}/${crypto.randomUUID()}/${name}`;
  const storage = tenant.db.storage.from(ATTACHMENTS_BUCKET);
  const uploaded = await storage.upload(path, new Blob([file], { type: mimeType }), {
    contentType: mimeType,
    upsert: false,
  });
  if (uploaded.error) throw uploadError(uploaded.error);

  const { data, error } = await files(tenant)
    .insert({
      project_id: projectId,
      workspace_id: tenant.workspace.id,
      user_id: tenant.userId,
      name,
      mime_type: mimeType,
      size: file.size,
      storage_path: path,
    })
    .select(FILE_COLUMNS)
    .single();
  if (error || !data) {
    await storage.remove([path]);
    throw new Error(`Database error: ${error?.message ?? "no row"}`);
  }
  return publicFile(toFile(data as FileRow));
}

export async function removeProjectFile(tenant: Tenant, projectId: string, fileId: string): Promise<boolean> {
  const rows = check(
    await files(tenant)
      .delete()
      .eq("id", fileId)
      .eq("project_id", projectId)
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId)
      .select("storage_path"),
  ) as { storage_path: string }[];
  await removeAttachmentFiles(
    tenant,
    rows.map((r) => r.storage_path),
  );
  return rows.length > 0;
}

/**
 * What a run in this project gets: its instructions for the agent context, and its files as
 * attachments when the agent can read files. Null when the project isn't the caller's.
 */
export async function projectForRun(
  tenant: Tenant,
  projectId: string,
  readsFiles: boolean,
): Promise<{
  context: NonNullable<AgentTenantContext["project"]>;
  files: AgentAttachment[];
} | null> {
  const row = await projectRow(tenant, projectId);
  if (!row) return null;
  const stored = readsFiles ? await storedFiles(tenant, projectId) : [];
  return {
    context: {
      name: row.name,
      instructions: row.instructions,
      files: stored.map((f) => f.name),
    },
    files: stored.map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: f.size,
      read: () => readAttachment(tenant, f),
    })),
  };
}

import type { StoredAttachment } from "@/lib/db/store";
import type { Tenant } from "@/lib/tenant";
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, type Attachment } from "@/lib/types";

// Files members attach to messages. Bytes live in the private "attachments" Storage bucket
// under <workspace>/<user>/, rows in public.attachments; both are reached only through the
// member's own session, so Storage policies and RLS keep each member's files to themselves.

const BUCKET = "attachments";
/** Uploaded files not yet sent with a message, per member. Keeps abandoned uploads bounded. */
const MAX_UNSENT = 20;

export function attachmentError(message: string, status = 400): Error {
  return Object.assign(new Error(message), { status });
}

/** The file's type, decided by its extension against the allowlist (never the browser's claim). */
export function attachmentType(name: string): string | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return ext ? (ATTACHMENT_TYPES[ext] ?? null) : null;
}

function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "").trim();
  return (cleaned || "file").slice(-150);
}

export async function uploadAttachment(tenant: Tenant, file: File): Promise<Attachment> {
  const name = safeName(file.name);
  const mimeType = attachmentType(name);
  if (!mimeType) throw attachmentError("That kind of file isn't supported. Try PDF, Word, CSV, text, or an image.", 415);
  if (file.size === 0) throw attachmentError("That file is empty.");
  if (file.size > MAX_ATTACHMENT_BYTES) throw attachmentError("Files can be up to 10 MB.", 413);

  const { count, error: countError } = await tenant.db
    .from("attachments")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", tenant.workspace.id)
    .eq("user_id", tenant.userId)
    .is("message_id", null);
  if (countError) throw new Error(countError.message);
  if ((count ?? 0) >= MAX_UNSENT) throw attachmentError("Too many files are waiting to be sent. Send or remove some first.", 429);

  const path = `${tenant.workspace.id}/${tenant.userId}/${crypto.randomUUID()}/${name}`;
  const storage = tenant.db.storage.from(BUCKET);
  const uploaded = await storage.upload(path, file, { contentType: mimeType, upsert: false });
  if (uploaded.error) throw new Error(`Storage error: ${uploaded.error.message}`);

  const { data, error } = await tenant.db
    .from("attachments")
    .insert({ workspace_id: tenant.workspace.id, user_id: tenant.userId, name, mime_type: mimeType, size: file.size, storage_path: path })
    .select("id, name, mime_type, size")
    .single();
  if (error || !data) {
    await storage.remove([path]);
    throw new Error(`Database error: ${error?.message ?? "no row"}`);
  }
  return { id: data.id, name: data.name, mimeType: data.mime_type, size: data.size };
}

/** Reads a stored file under the member's session. */
export async function readAttachment(tenant: Tenant, attachment: StoredAttachment): Promise<Blob> {
  const { data, error } = await tenant.db.storage.from(BUCKET).download(attachment.storagePath);
  if (error || !data) throw attachmentError("That file couldn't be read.", 404);
  return data;
}

/** Removes a file that hasn't been sent yet. */
export async function removeUnsentAttachment(tenant: Tenant, id: string): Promise<boolean> {
  const { data, error } = await tenant.db
    .from("attachments")
    .delete()
    .eq("id", id)
    .eq("workspace_id", tenant.workspace.id)
    .eq("user_id", tenant.userId)
    .is("message_id", null)
    .select("storage_path");
  if (error) throw new Error(error.message);
  const paths = (data ?? []).map((r: { storage_path: string }) => r.storage_path);
  if (paths.length > 0) await removeAttachmentFiles(tenant, paths);
  return paths.length > 0;
}

/** Deletes stored bytes (their rows go with their messages). Best effort. */
export async function removeAttachmentFiles(tenant: Tenant, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const { error } = await tenant.db.storage.from(BUCKET).remove(paths);
  if (error) console.error("[attachments] couldn't remove files", error.message);
}

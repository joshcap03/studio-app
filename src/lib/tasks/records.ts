import type { Tenant } from "@/lib/tenant-core";
import { check, fail, time } from "./db";
import { MAX_RECORDS_PER_COLLECTION, type RecordPatch, type RecordUpsert } from "./schema";
import type { AgentRecord } from "./types";

// The agent's tracker: rows it keeps across runs in named collections (e.g. job applications
// keyed by job URL). Private to the member, like tasks; the database caps each collection.

interface RecordRow {
  id: string;
  collection: string;
  key: string;
  title: string;
  status: string | null;
  url: string | null;
  fields: Record<string, unknown>;
  task_id: string | null;
  source_message_id: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = "id, collection, key, title, status, url, fields, task_id, source_message_id, created_at, updated_at";
const MISSING_LINK = "That task or message doesn't exist.";

const toRecord = (r: RecordRow): AgentRecord => ({
  id: r.id,
  collection: r.collection,
  key: r.key,
  title: r.title,
  status: r.status,
  url: r.url,
  fields: r.fields,
  taskId: r.task_id,
  sourceMessageId: r.source_message_id,
  createdAt: Date.parse(r.created_at),
  updatedAt: Date.parse(r.updated_at),
});

const records = (tenant: Tenant) => tenant.db.from("agent_records");

// Only the columns a record may change after it's created; collection and key identify it.
function changes(input: RecordPatch & Pick<RecordUpsert, "taskId" | "sourceMessageId">): Record<string, unknown> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.title !== undefined) row.title = input.title;
  if (input.status !== undefined) row.status = input.status;
  if (input.url !== undefined) row.url = input.url;
  if (input.fields !== undefined) row.fields = input.fields;
  if (input.taskId !== undefined) row.task_id = input.taskId;
  if (input.sourceMessageId !== undefined) row.source_message_id = input.sourceMessageId;
  return row;
}

export async function listRecords(tenant: Tenant, collection?: string): Promise<AgentRecord[]> {
  let query = records(tenant).select(COLUMNS).eq("workspace_id", tenant.workspace.id).eq("user_id", tenant.userId);
  if (collection) query = query.eq("collection", collection);
  const rows = check(await query.order("updated_at", { ascending: false }).limit(MAX_RECORDS_PER_COLLECTION)) as RecordRow[];
  return rows.map(toRecord);
}

/** Adds a record, or updates the one already in its collection under the same key. */
export async function upsertRecord(tenant: Tenant, input: RecordUpsert): Promise<AgentRecord> {
  const inserted = await records(tenant)
    .insert({
      workspace_id: tenant.workspace.id,
      user_id: tenant.userId,
      collection: input.collection,
      key: input.key,
      title: input.title ?? "",
      status: input.status ?? null,
      url: input.url ?? null,
      fields: input.fields ?? {},
      task_id: input.taskId ?? null,
      source_message_id: input.sourceMessageId ?? null,
    })
    .select(COLUMNS)
    .single();
  if (inserted.error?.hint === "record_limit") {
    fail(409, `"${input.collection}" already holds ${MAX_RECORDS_PER_COLLECTION} records. Remove some first.`);
  }
  // Tenancy columns can't be updated, so an existing key is updated separately rather than
  // through an on-conflict upsert.
  if (inserted.error?.code !== "23505") return toRecord(check(inserted, MISSING_LINK) as RecordRow);
  const rows = check(
    await records(tenant)
      .update(changes(input))
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId)
      .eq("collection", input.collection)
      .eq("key", input.key)
      .select(COLUMNS),
    MISSING_LINK,
  ) as RecordRow[];
  if (!rows[0]) throw new Error("record vanished during upsert");
  return toRecord(rows[0]);
}

export async function updateRecord(tenant: Tenant, id: string, patch: RecordPatch): Promise<AgentRecord | null> {
  const rows = check(
    await records(tenant)
      .update(changes(patch))
      .eq("id", id)
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId)
      .select(COLUMNS),
  ) as RecordRow[];
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function deleteRecord(tenant: Tenant, id: string): Promise<boolean> {
  const rows = check(
    await records(tenant).delete().eq("id", id).eq("workspace_id", tenant.workspace.id).eq("user_id", tenant.userId).select("id"),
  ) as { id: string }[];
  return rows.length > 0;
}

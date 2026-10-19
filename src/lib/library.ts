import { z } from "zod";
import type { AgentTenantContext } from "@/lib/agent/types";
import { check, fail } from "@/lib/tasks/db";
import type { Tenant } from "@/lib/tenant-core";
import { MAX_LIBRARY_ITEMS, type Artifact, type ArtifactKind, type LibraryItem } from "@/lib/types";

// The member's Library for one agent: the docs and sheets the agent made for them, filed from
// its tools' own results (never parsed from text), and links the member added. Private to the
// member, like tasks and the tracker: every query is filtered by the tenant's workspace and
// user, and RLS enforces the same. The table is agent_artifacts.

interface ItemRow {
  id: string;
  kind: ArtifactKind;
  title: string;
  url: string;
  description: string | null;
  source: string | null;
  added_by: "agent" | "member";
  pinned: boolean;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = "id, kind, title, url, description, source, added_by, pinned, conversation_id, created_at, updated_at";

const toItem = (r: ItemRow): LibraryItem => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  url: r.url,
  description: r.description,
  source: r.source,
  addedBy: r.added_by,
  pinned: r.pinned,
  conversationId: r.conversation_id,
  createdAt: Date.parse(r.created_at),
  updatedAt: Date.parse(r.updated_at),
});

export const addLinkBody = z.strictObject({
  url: z.url({ protocol: /^https$/, error: "Use an https link." }).max(4000),
  title: z.string().trim().max(300).optional(),
});

export const patchItemBody = z
  .strictObject({ title: z.string().trim().min(1, "Give it a name.").max(300), pinned: z.boolean() })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "Nothing to change.");

const items = (tenant: Tenant) => tenant.db.from("agent_artifacts");
const MISSING_LINK = "That conversation doesn't exist.";
const FULL = `Your Library holds up to ${MAX_LIBRARY_ITEMS} items. Remove some first.`;
const capped = (error: { hint?: string } | null) => error?.hint === "artifact_limit";

/** Pinned first, then most recently made or used. */
export async function listLibrary(tenant: Tenant, limit = MAX_LIBRARY_ITEMS): Promise<LibraryItem[]> {
  const rows = check(
    await items(tenant)
      .select(COLUMNS)
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId)
      .order("pinned", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(limit),
  ) as ItemRow[];
  return rows.map(toItem);
}

const GOOGLE: [RegExp, ArtifactKind, string, string][] = [
  [/^\/spreadsheets\//, "spreadsheet", "Google Sheets", "Google Sheet"],
  [/^\/document\//, "document", "Google Docs", "Google Doc"],
  [/^\/presentation\//, "presentation", "Google Slides", "Google Slides deck"],
  [/^\/forms\//, "link", "Google Forms", "Google Form"],
];

function fileName(pathname: string): string {
  const last = pathname.split("/").pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** What a link the member pastes probably is, from its address alone (nothing is fetched). */
export function describeLink(url: string): { kind: ArtifactKind; source: string; title: string } {
  const { hostname, pathname } = new URL(url);
  const host = hostname.replace(/^www\./, "");
  if (host === "docs.google.com") {
    const match = GOOGLE.find(([path]) => path.test(pathname));
    if (match) {
      const [, kind, source, title] = match;
      return { kind, source, title };
    }
  }
  if (host === "drive.google.com") return { kind: "file", source: "Google Drive", title: "Google Drive file" };
  if (host === "notion.so" || host.endsWith(".notion.site")) return { kind: "document", source: "Notion", title: "Notion page" };
  if (/\.pdf$/i.test(pathname)) return { kind: "pdf", source: host, title: fileName(pathname).slice(0, 300) };
  return { kind: "link", source: host, title: host };
}

/**
 * Files an artifact the agent made, from a tool's own structured result. Making the same link
 * again moves its row up and points it at the latest chat; the title the member sees stays.
 * Best-effort: a full Library or a missing link leaves the reply as it was.
 */
export async function fileArtifact(
  tenant: Tenant,
  artifact: Artifact,
  where: { conversationId: string; messageId: string },
): Promise<LibraryItem | null> {
  if (!artifact.url) return null;
  const inserted = await items(tenant)
    .insert({
      workspace_id: tenant.workspace.id,
      user_id: tenant.userId,
      kind: artifact.kind,
      title: artifact.title,
      url: artifact.url,
      description: artifact.description ?? null,
      source: artifact.source ?? null,
      added_by: "agent",
      conversation_id: where.conversationId,
      source_message_id: where.messageId,
    })
    .select(COLUMNS)
    .single();
  if (capped(inserted.error)) return null;
  if (inserted.error?.code !== "23505") return toItem(check(inserted, MISSING_LINK) as ItemRow);
  const rows = check(
    await items(tenant)
      .update({ conversation_id: where.conversationId, source_message_id: where.messageId, updated_at: new Date().toISOString() })
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId)
      .eq("url", artifact.url)
      .select(COLUMNS),
    MISSING_LINK,
  ) as ItemRow[];
  return rows[0] ? toItem(rows[0]) : null;
}

/** A link the member files themselves, e.g. a Google Doc they already keep. */
export async function addLink(tenant: Tenant, input: z.infer<typeof addLinkBody>): Promise<LibraryItem> {
  const guess = describeLink(input.url);
  const inserted = await items(tenant)
    .insert({
      workspace_id: tenant.workspace.id,
      user_id: tenant.userId,
      kind: guess.kind,
      title: input.title?.trim() || guess.title,
      url: input.url,
      source: guess.source,
      added_by: "member",
    })
    .select(COLUMNS)
    .single();
  if (capped(inserted.error)) fail(409, FULL);
  if (inserted.error?.code === "23505") fail(409, "That link is already in your Library.");
  return toItem(check(inserted) as ItemRow);
}

export async function updateLibraryItem(tenant: Tenant, id: string, patch: z.infer<typeof patchItemBody>): Promise<LibraryItem | null> {
  const row: Record<string, unknown> = {};
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.pinned !== undefined) row.pinned = patch.pinned;
  const rows = check(
    await items(tenant).update(row).eq("id", id).eq("workspace_id", tenant.workspace.id).eq("user_id", tenant.userId).select(COLUMNS),
  ) as ItemRow[];
  return rows[0] ? toItem(rows[0]) : null;
}

export async function removeLibraryItem(tenant: Tenant, id: string): Promise<boolean> {
  const rows = check(
    await items(tenant).delete().eq("id", id).eq("workspace_id", tenant.workspace.id).eq("user_id", tenant.userId).select("id"),
  ) as { id: string }[];
  return rows.length > 0;
}

/** How much of the Library the agent sees on each run: pinned items, then the most recent. */
const CONTEXT_ITEMS = 40;

/** The Library for the agent's context; a run goes ahead without it on error. */
export async function libraryContextFor(tenant: Tenant): Promise<AgentTenantContext["library"]> {
  try {
    const list = await listLibrary(tenant, CONTEXT_ITEMS);
    return list.map(({ title, kind, url, pinned }) => ({ title, kind, url, pinned }));
  } catch (e) {
    console.error("[context] couldn't load the Library", e);
    return undefined;
  }
}

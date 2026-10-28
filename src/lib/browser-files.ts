import { createHash } from "node:crypto";
import { ATTACHMENTS_BUCKET, attachmentType, uploadError } from "@/lib/attachments";
import { attachToPage, browserConnection, defaultConnect, withCdp, type CdpCall, type SocketFactory } from "@/lib/browser-view";
import { getConfig } from "@/lib/config";
import type { Tenant } from "@/lib/tenant-core";
import { MAX_ATTACHMENT_BYTES, type Attachment } from "@/lib/types";

// Files from the agent's browser, for the member: a shipping label, a receipt, an invoice the site
// made. The agent's save_file names the file and, usually, gives its link as the page has it. The
// server then fetches it from the conversation's own browser over CDP, the way the page itself
// would (Network.loadNetworkResource, with the page's cookies, so a signed-in download works), or
// with no link prints the open page to a PDF. Nothing is clicked or typed, and no file passes
// through the agent. It's saved as an attachment on the reply that asked for it, in the member's own
// folder under their session, and shows there for them to download.
//
// To email one, the agent needs Composio's key for the file: later runs in the conversation list
// its files from the browser with one (browserFilesFor), staged in Composio's file store, which its
// Gmail tool attaches from. Free of next/*.

/** How long fetching one file from the browser may take, start to finish. */
const FETCH_MS = 30_000;
/** Bytes asked for per read of a fetched file's stream. */
const CHUNK = 1024 * 1024;
/** Files from the browser each run hears about, newest first. */
const LISTED = 5;
/** How long after it was saved a file is staged for the agent to attach. */
const STAGED_FOR_MS = 7 * 24 * 3600 * 1000;
const COMPOSIO_API = "https://backend.composio.dev/api/v3";

export interface BrowserFileRequest {
  name: string;
  link?: string;
}

/** What save_file reported, if it's usable: a name, and a link as the page has it. */
export function parseBrowserFile(raw: unknown): BrowserFileRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const { name, link } = raw as Record<string, unknown>;
  if (typeof name !== "string" || !name.trim()) return null;
  const request: BrowserFileRequest = { name: name.replace(/\s+/g, " ").trim().slice(0, 120) };
  if (typeof link === "string" && link.trim() && link.length <= 4000 && !/\s/.test(link.trim())) request.link = link.trim();
  return request;
}

/**
 * A name the member can save: theirs, with the extension of the type the file really is (never the
 * one the agent's name claims), and only a type Studio keeps.
 */
export function fileName(asked: string, mimeType: string): { name: string; mimeType: string } | null {
  const ext = EXTENSIONS[mimeType.split(";")[0].trim().toLowerCase()];
  if (!ext) return null;
  const base = (asked.split(/[\\/]/).pop() ?? "")
    .replace(/[^\w.\- ()]+/g, "_")
    .replace(/^\.+/, "")
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .trim() || "file";
  return { name: `${base.slice(0, 140)}.${ext}`, mimeType: attachmentType(`x.${ext}`)! };
}

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "text/csv": "csv",
  "text/plain": "txt",
  "application/json": "json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

/** The type a file's first bytes show, for one served without a usable type (a label as octet-stream). */
export function sniffType(bytes: Uint8Array): string {
  const head = Buffer.from(bytes.subarray(0, 8));
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  return "";
}

export type Fetched = { ok: true; bytes: Uint8Array; mimeType: string } | { ok: false; reason: "off" | "none" | "ended" | "failed" | "too-big" | "refused" };

/**
 * The file from the conversation's browser: its link fetched as the open page would (cookies
 * included; https or the page's own blob: links only), or with no link the open page as a PDF.
 */
export async function fetchFromBrowser(
  tenant: Tenant,
  conversationId: string,
  request: BrowserFileRequest,
  connect: SocketFactory = defaultConnect,
): Promise<Fetched> {
  const connection = await browserConnection(tenant, conversationId);
  if (!connection.ok) return connection;
  try {
    return await withCdp(connection.url, connect, FETCH_MS, (call) => fetchOnPage(call, request.link));
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** The fetch itself, on the page the agent is on. Exported for tests. */
export async function fetchOnPage(call: CdpCall, link: string | undefined): Promise<Fetched> {
  const { sessionId } = await attachToPage(call);
  if (!link) {
    const { data } = (await call("Page.printToPDF", { printBackground: true, preferCSSPageSize: true }, sessionId)) as { data?: string };
    if (!data) return { ok: false, reason: "failed" };
    const bytes = new Uint8Array(Buffer.from(data, "base64"));
    return bytes.length > MAX_ATTACHMENT_BYTES ? { ok: false, reason: "too-big" } : { ok: true, bytes, mimeType: "application/pdf" };
  }
  const { frameTree } = (await call("Page.getFrameTree", {}, sessionId)) as { frameTree?: { frame?: { id?: string; url?: string } } };
  const frame = frameTree?.frame;
  if (!frame?.id || !frame.url) return { ok: false, reason: "failed" };
  let url: URL;
  try {
    url = new URL(link, frame.url);
  } catch {
    return { ok: false, reason: "refused" };
  }
  if (url.protocol === "blob:") return blobOnPage(call, sessionId, url.href, frame.url);
  if (url.protocol !== "https:") return { ok: false, reason: "refused" };

  // Loading a resource as the page needs the page's network domain on (it's off again when we go).
  await call("Network.enable", {}, sessionId);
  const { resource } = (await call(
    "Network.loadNetworkResource",
    { frameId: frame.id, url: url.href, options: { disableCache: false, includeCredentials: true } },
    sessionId,
  )) as { resource?: { success?: boolean; httpStatusCode?: number; stream?: string; headers?: Record<string, string> } };
  if (!resource?.success || !resource.stream || (resource.httpStatusCode ?? 200) >= 400) return { ok: false, reason: "failed" };
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { data, base64Encoded, eof } = (await call("IO.read", { handle: resource.stream, size: CHUNK }, sessionId)) as {
        data?: string;
        base64Encoded?: boolean;
        eof?: boolean;
      };
      const chunk = Buffer.from(data ?? "", base64Encoded ? "base64" : "utf8");
      size += chunk.length;
      if (size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: "too-big" };
      chunks.push(chunk);
      if (eof) break;
    }
  } finally {
    await call("IO.close", { handle: resource.stream }, sessionId).catch(() => undefined);
  }
  if (size === 0) return { ok: false, reason: "failed" };
  const type = Object.entries(resource.headers ?? {}).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  return { ok: true, bytes: new Uint8Array(Buffer.concat(chunks)), mimeType: type };
}

/** A blob: link only the page itself can read (a label the site drew in the page), read there. */
async function blobOnPage(call: CdpCall, sessionId: string, href: string, pageUrl: string): Promise<Fetched> {
  // Only the page's own blobs: a blob: URL carries its creator's origin.
  if (new URL(href.slice("blob:".length)).origin !== new URL(pageUrl).origin) return { ok: false, reason: "refused" };
  const expression = `(async () => {
    const blob = await (await fetch(${JSON.stringify(href)})).blob();
    if (blob.size > ${MAX_ATTACHMENT_BYTES}) return { tooBig: true };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = "";
    for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return { type: blob.type, data: btoa(text) };
  })()`;
  const { result } = (await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)) as {
    result?: { value?: { tooBig?: boolean; type?: string; data?: string } };
  };
  const value = result?.value;
  if (value?.tooBig) return { ok: false, reason: "too-big" };
  if (!value?.data) return { ok: false, reason: "failed" };
  return { ok: true, bytes: new Uint8Array(Buffer.from(value.data, "base64")), mimeType: value.type ?? "" };
}

/** Why a file couldn't be saved, as the member reads it on the reply. */
const MISSES: Record<Exclude<Fetched, { ok: true }>["reason"] | "type" | "page", string> = {
  off: "the browser isn't set up here",
  none: "the browser wasn't open",
  ended: "the browser had closed",
  failed: "the browser couldn't get it",
  "too-big": "it's over 10 MB",
  refused: "its link isn't one Studio fetches",
  type: "Studio doesn't keep that kind of file",
  page: "the site sent a web page instead of the file (it may want you signed in)",
};

export type Saved = { ok: true; attachment: Attachment } | { ok: false; name: string; why: string };

/**
 * Gets the file save_file asked for from the conversation's browser and keeps it on the reply
 * (`messageId`, the agent's own message in this conversation), under the member's session.
 */
export async function saveBrowserFile(
  tenant: Tenant,
  conversationId: string,
  messageId: string,
  raw: unknown,
  connect: SocketFactory = defaultConnect,
): Promise<Saved | null> {
  const request = parseBrowserFile(raw);
  if (!request) return null;
  const fetched = await fetchFromBrowser(tenant, conversationId, request, connect);
  if (!fetched.ok) return { ok: false, name: request.name, why: MISSES[fetched.reason] };
  const type = sniffType(fetched.bytes) || fetched.mimeType;
  const named = fileName(request.name, type);
  if (!named) return { ok: false, name: request.name, why: /^text\/html\b/i.test(type) ? MISSES.page : MISSES.type };

  const path = `${tenant.workspace.id}/${tenant.userId}/${crypto.randomUUID()}/${named.name}`;
  const storage = tenant.db.storage.from(ATTACHMENTS_BUCKET);
  const uploaded = await storage.upload(path, new Blob([fetched.bytes as BlobPart], { type: named.mimeType }), { contentType: named.mimeType, upsert: false });
  if (uploaded.error) throw uploadError(uploaded.error);
  const { data, error } = await tenant.db
    .from("attachments")
    .insert({
      workspace_id: tenant.workspace.id,
      user_id: tenant.userId,
      message_id: messageId,
      name: named.name,
      mime_type: named.mimeType,
      size: fetched.bytes.length,
      storage_path: path,
      browser_md5: createHash("md5").update(fetched.bytes).digest("hex"),
    })
    .select("id, name, mime_type, size")
    .single();
  if (error || !data) {
    await storage.remove([path]);
    throw new Error(`Database error: ${error?.message ?? "no row"}`);
  }
  return { ok: true, attachment: { id: data.id, name: data.name, mimeType: data.mime_type, size: data.size } };
}

export interface BrowserFileContext {
  name: string;
  mimeType: string;
  /** Composio's key for the file, to attach it with an app tool (Gmail's attachment.s3key). */
  s3key?: string;
}

/**
 * The files the agent's browser got in this conversation, newest first, each staged in Composio's
 * file store so the agent can attach it to an email (each run stages its own copy: Composio's keys
 * are temporary). One that can't be staged, or is over a week old, is still listed, without a key.
 */
export async function browserFilesFor(tenant: Tenant, conversationId: string): Promise<BrowserFileContext[]> {
  const { data, error } = await tenant.db
    .from("attachments")
    .select("name, mime_type, storage_path, browser_md5, created_at, messages!inner(conversation_id)")
    .eq("messages.conversation_id", conversationId)
    .not("browser_md5", "is", null)
    .eq("workspace_id", tenant.workspace.id)
    .eq("user_id", tenant.userId)
    .order("created_at", { ascending: false })
    .limit(LISTED);
  if (error) throw new Error(error.message);
  const rows = data as { name: string; mime_type: string; storage_path: string; browser_md5: string; created_at: string }[];
  const fresh = Date.now() - STAGED_FOR_MS;
  return Promise.all(
    rows.map(async (row) => {
      // Composio keeps no copy by digest, so each run stages again; only files from the last week.
      const s3key = Date.parse(row.created_at) < fresh ? null : await composioFileFor(tenant, row).catch((e) => {
        console.error("[browser-files] couldn't stage a file for the agent", e instanceof Error ? e.message : e);
        return null;
      });
      return { name: row.name, mimeType: row.mime_type, ...(s3key ? { s3key } : {}) };
    }),
  );
}

/** Composio's key for one stored file, uploaded to its file store. */
async function composioFileFor(tenant: Tenant, row: { name: string; mime_type: string; storage_path: string; browser_md5: string }): Promise<string | null> {
  const composio = getConfig().composio;
  if (!composio) return null;
  const res = await fetch(`${COMPOSIO_API}/files/upload/request`, {
    method: "POST",
    headers: { "x-api-key": composio.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ toolkit_slug: "gmail", tool_slug: "GMAIL_SEND_EMAIL", filename: row.name, mimetype: row.mime_type, md5: row.browser_md5 }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Composio file request ${res.status}`);
  const staged = (await res.json()) as { key?: unknown; type?: unknown; new_presigned_url?: unknown };
  if (typeof staged.key !== "string" || !staged.key) return null;
  // A file Composio already has comes back without a link to upload to.
  if (typeof staged.new_presigned_url === "string" && staged.new_presigned_url) {
    if (!/^https:\/\//.test(staged.new_presigned_url)) return null;
    const { data: blob, error } = await tenant.db.storage.from(ATTACHMENTS_BUCKET).download(row.storage_path);
    if (error || !blob) return null;
    const put = await fetch(staged.new_presigned_url, {
      method: "PUT",
      headers: { "Content-Type": row.mime_type },
      body: blob,
      signal: AbortSignal.timeout(15_000),
    });
    if (!put.ok) throw new Error(`Composio file upload ${put.status}`);
  }
  return staged.key;
}

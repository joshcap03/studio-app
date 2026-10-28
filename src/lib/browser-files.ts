import { createHash } from "node:crypto";
import { ATTACHMENTS_BUCKET, uploadError } from "@/lib/attachments";
import { attachToPage, browserConnection, defaultConnect, recordedSession, withCdp, type CdpCall, type SocketFactory } from "@/lib/browser-view";
import { getConfig } from "@/lib/config";
import type { Tenant } from "@/lib/tenant-core";
import { MAX_ATTACHMENT_BYTES, type Attachment } from "@/lib/types";

// Files from the agent's browser, for the member: a shipping label, a receipt, an invoice the site
// made. The agent's save_file names the file and gives its link as the page has it, or the name of
// a file a click downloaded. The server then fetches it from the conversation's own browser over
// CDP, the way the page itself would (Network.loadNetworkResource, with the page's cookies, so a
// signed-in download works); takes a downloaded one from Browserbase's store (Studio Browser turns
// downloads on around a click the agent expects to download, langflow/components/studio_browser.py);
// or with neither prints the open page to a PDF. Nothing is clicked or typed here, and no file
// passes through the agent. It's saved as an attachment on the reply that asked for it, in the member's own
// folder under their session, and shows there for them to download.
//
// To email one, the agent needs Composio's key for the file: later runs in the conversation list
// its files from the browser with one (browserFilesFor), staged in Composio's file store, which
// Gmail's and Outlook's send, draft, and reply tools attach from. Free of next/*.

/** How long fetching one file from the browser may take, start to finish. */
const FETCH_MS = 30_000;
/** Bytes asked for per read of a fetched file's stream. */
const CHUNK = 1024 * 1024;
/** Files from the browser each run hears about, newest first. */
const LISTED = 5;
/** How long after it was saved a file is staged for the agent to attach. */
const STAGED_FOR_MS = 7 * 24 * 3600 * 1000;
/** How long a key from Composio's file store is reused before it's asked for again (Composio keeps a staged file for a day). */
const COMPOSIO_KEY_FRESH_MS = 60 * 60 * 1000;
const COMPOSIO_API = "https://backend.composio.dev/api/v3";
const BROWSERBASE_API = "https://api.browserbase.com/v1";
/** How long to wait for a file the browser downloaded to reach Browserbase's store. */
const DOWNLOAD_SYNC_MS = 15_000;
/** A download this recent stands in for one the site named differently. */
const RECENT_DOWNLOAD_MS = 5 * 60_000;

export interface BrowserFileRequest {
  name: string;
  /** The file's link as the page has it. */
  link?: string;
  /** The name of a file a click downloaded in the browser (from the browser's own note to the agent). */
  downloaded?: string;
}

/** What save_file reported, if it's usable: a name, and a link as the page has it or a download's name. */
export function parseBrowserFile(raw: unknown): BrowserFileRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const { name, link, downloaded } = raw as Record<string, unknown>;
  if (typeof name !== "string" || !name.trim()) return null;
  const request: BrowserFileRequest = { name: name.replace(/\s+/g, " ").trim().slice(0, 120) };
  if (typeof downloaded === "string" && downloaded.trim()) request.downloaded = downloaded.replace(/\s+/g, " ").trim().slice(0, 255);
  else if (typeof link === "string" && link.trim() && link.length <= 4000 && !/\s/.test(link.trim())) request.link = link.trim();
  return request;
}

/**
 * A name the member can save: theirs, with the extension of the type the file really is (never the
 * one the agent's name claims), and only a type Studio keeps.
 */
export function fileName(asked: string, mimeType: string): { name: string; mimeType: string } | null {
  const type = bare(mimeType);
  const ext = Object.entries(TYPES).find(([, t]) => t === type)?.[0];
  if (!ext) return null;
  const base = (asked.split(/[\\/]/).pop() ?? "")
    .replace(/[^\w.\- ()]+/g, "_")
    .replace(/^\.+/, "")
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .trim() || "file";
  return { name: `${base.slice(0, 140)}.${ext}`, mimeType: TYPES[ext] };
}

/**
 * What Studio keeps from the browser, by extension. More than members may attach to a message
 * (sheets and zips: exports, statements), since these are only ever downloaded, never read by the agent.
 */
const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  csv: "text/csv",
  txt: "text/plain",
  json: "application/json",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  zip: "application/zip",
};

const bare = (mimeType: string) => {
  const type = mimeType.split(";")[0].trim().toLowerCase();
  return type === "application/x-zip-compressed" ? TYPES.zip : type;
};
const named = (asked: string) => asked.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1] ?? "";

/**
 * The type a file really is: what its first bytes show (the site's word or the agent's name only
 * tell which kind of zip or Office file it is), or for text, what the site says. A file whose bytes
 * aren't what the site claims (HTML sent as a PDF) has no type, so it isn't kept.
 */
export function fileType(bytes: Uint8Array, declared: string, asked: string): string {
  const head = Buffer.from(bytes.subarray(0, 8));
  const said = bare(declared);
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return TYPES.pdf;
  if (head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return TYPES.png;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return TYPES.jpg;
  if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    // Word and Excel files are zips inside; which one is in the type the site sent, or the name.
    for (const office of [TYPES.docx, TYPES.xlsx]) if (said === office) return office;
    const ext = named(asked);
    return ext === "docx" || ext === "xlsx" ? TYPES[ext] : TYPES.zip;
  }
  if (head.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    // An older Office file: kept only as the spreadsheet the site or the name says it is.
    return said === TYPES.xls || named(asked) === "xls" ? TYPES.xls : "";
  }
  // A web page, whatever the site called it (a sign-in page sent where the file was asked for).
  if (/^\s*<(!doctype html|html|head|body)\b/i.test(Buffer.from(bytes.subarray(0, 512)).toString("latin1"))) return "text/html";
  // Text the site sent as text; a binary type with other bytes in it is something else.
  return [TYPES.csv, TYPES.txt, TYPES.json, "text/html"].includes(said) ? said : "";
}

export type Fetched =
  | { ok: true; bytes: Uint8Array; mimeType: string }
  | { ok: false; reason: "off" | "none" | "ended" | "failed" | "too-big" | "refused" | "no-download" };

/**
 * The file from the conversation's browser: one a click downloaded there, from Browserbase's store;
 * its link fetched as the open page would (cookies included; https or the page's own blob: links
 * only); or with neither, the open page as a PDF.
 */
export async function fetchFromBrowser(
  tenant: Tenant,
  conversationId: string,
  request: BrowserFileRequest,
  connect: SocketFactory = defaultConnect,
): Promise<Fetched> {
  if (request.downloaded) {
    const session = await recordedSession(tenant, conversationId);
    if (!session.ok) return session;
    try {
      return await fetchDownload(session.apiKey, session.sessionId, request.downloaded);
    } catch {
      return { ok: false, reason: "failed" };
    }
  }
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

interface Download {
  id: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  createdAt?: string;
}

/**
 * A file the conversation's browser downloaded, from Browserbase's store: the newest one with that
 * name, waited for a little since the store fills just after the download; failing that, the newest
 * from the last few minutes (a site may name the file differently than it said). Exported for tests
 * (`wait` stands in for the delay between looks).
 */
export async function fetchDownload(
  apiKey: string,
  sessionId: string,
  filename: string,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Fetched> {
  const headers = { "X-BB-API-Key": apiKey };
  let found: Download | undefined;
  let recent: Download | undefined;
  for (let waited = 0; !found && waited <= DOWNLOAD_SYNC_MS; waited += 1500) {
    if (waited) await wait(1500);
    const res = await fetch(`${BROWSERBASE_API}/downloads?sessionId=${encodeURIComponent(sessionId)}&limit=100`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, reason: res.status === 404 ? "ended" : "failed" };
    const listed = ((await res.json()) as { downloads?: Download[] }).downloads ?? [];
    const newest = [...listed].filter((d) => typeof d.id === "string").sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));
    found = newest.find((d) => d.filename === filename);
    recent = newest.find((d) => Date.now() - Date.parse(d.createdAt ?? "") < RECENT_DOWNLOAD_MS);
  }
  found ??= recent;
  if (!found) return { ok: false, reason: "no-download" };
  if ((found.size ?? 0) > MAX_ATTACHMENT_BYTES) return { ok: false, reason: "too-big" };
  const file = await fetch(`${BROWSERBASE_API}/downloads/${encodeURIComponent(found.id)}`, {
    headers: { ...headers, Accept: "application/octet-stream" },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!file.ok) return { ok: false, reason: "failed" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) return { ok: false, reason: "failed" };
  if (bytes.length > MAX_ATTACHMENT_BYTES) return { ok: false, reason: "too-big" };
  return { ok: true, bytes, mimeType: found.mimeType ?? file.headers.get("content-type") ?? "" };
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
  "no-download": "the browser hadn't downloaded it",
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
  const type = fileType(fetched.bytes, fetched.mimeType, request.downloaded ?? request.name);
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
    .select("id, name, mime_type, storage_path, browser_md5, created_at, composio_key, composio_key_at, messages!inner(conversation_id)")
    .eq("messages.conversation_id", conversationId)
    .not("browser_md5", "is", null)
    .eq("workspace_id", tenant.workspace.id)
    .eq("user_id", tenant.userId)
    .order("created_at", { ascending: false })
    .limit(LISTED);
  if (error) throw new Error(error.message);
  const rows = data as BrowserFileRow[];
  const fresh = Date.now() - STAGED_FOR_MS;
  return Promise.all(
    rows.map(async (row) => {
      // Only files from the last week; a key from the last hour is reused, the rest staged again.
      const s3key = Date.parse(row.created_at) < fresh ? null : await composioKeyFor(tenant, row).catch((e) => {
        console.error("[browser-files] couldn't stage a file for the agent", e instanceof Error ? e.message : e);
        return null;
      });
      return { name: row.name, mimeType: row.mime_type, ...(s3key ? { s3key } : {}) };
    }),
  );
}

interface BrowserFileRow {
  id: string;
  name: string;
  mime_type: string;
  storage_path: string;
  browser_md5: string;
  created_at: string;
  composio_key: string | null;
  composio_key_at: string | null;
}

/**
 * Composio's key for one stored file: the one kept with the row while it's fresh, else a new one
 * from Composio, kept with the row for the next run (best effort).
 */
async function composioKeyFor(tenant: Tenant, row: BrowserFileRow): Promise<string | null> {
  if (row.composio_key && row.composio_key_at && Date.now() - Date.parse(row.composio_key_at) < COMPOSIO_KEY_FRESH_MS) return row.composio_key;
  const key = await composioFileFor(tenant, row);
  if (key) {
    const { error } = await tenant.db
      .from("attachments")
      .update({ composio_key: key, composio_key_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("workspace_id", tenant.workspace.id)
      .eq("user_id", tenant.userId);
    if (error) console.error("[browser-files] couldn't keep the file's Composio key", error.message);
  }
  return key;
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

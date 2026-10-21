import { createHmac, timingSafeEqual } from "node:crypto";
import { getConfig } from "@/lib/config";
import type { Tenant } from "@/lib/tenant-core";

// Watching the agent's browser, and taking it over. Studio Browser
// (langflow/components/studio_browser.py) opens one hosted browser per conversation and tags each
// browser result with its session id; the turn keeps that id on the conversation, sealed with a
// MAC made with the app's own Browserbase key, since the member can write that column.
//
// Watching (on a call) is view only: the server asks Browserbase for the session (only this
// conversation's, only while it runs), connects to it over CDP itself, takes one JPEG of the page,
// and disconnects. The page gets pictures only.
//
// Taking over is the one way a link that drives the browser reaches the page: when the agent has
// handed its browser to the member (hand_browser) and they tap Take over, the server asks
// Browserbase for a live view of the page the agent is on, good for CONTROL_S, and returns it to
// that member alone, uncached. It's never stored, never sent to the agent, and the connection
// URL itself still never leaves the server. Free of next/* (the turn records the session).

const API = "https://api.browserbase.com/v1";
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long one screenshot may take, start to finish. */
const FRAME_MS = 8000;
/** How long a link to take over the browser can be opened, from the member's tap. */
const CONTROL_S = 600;
/** Where Browserbase serves its live view. */
const LIVE_VIEW = /^https:\/\/(?:[a-z0-9-]+\.)*browserbase\.com\//i;

function mac(apiKey: string, conversationId: string, userId: string, sessionId: string): string {
  return createHmac("sha256", apiKey).update(`studio-browser:${conversationId}:${userId}:${sessionId}`).digest("base64url");
}

/** The session id as stored: bound to this conversation and member by the app's own key. */
export function sealSession(apiKey: string, conversationId: string, userId: string, sessionId: string): string {
  return `${sessionId}.${mac(apiKey, conversationId, userId, sessionId)}`;
}

/** The session id, if `sealed` is this conversation's and this member's; null otherwise. */
export function openSession(apiKey: string, conversationId: string, userId: string, sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const at = sealed.indexOf(".");
  const id = sealed.slice(0, at);
  if (at < 0 || !SESSION_ID.test(id)) return null;
  const given = Buffer.from(sealed.slice(at + 1));
  const expected = Buffer.from(mac(apiKey, conversationId, userId, id));
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
}

/**
 * Records the conversation's browser (or that it ended, with null), under the member's session.
 * A no-op when watching is off. An id that isn't a Browserbase session id is ignored.
 */
export async function saveBrowserSession(tenant: Tenant, conversationId: string, sessionId: string | null): Promise<void> {
  const browser = getConfig().browser;
  if (!browser || (sessionId !== null && !SESSION_ID.test(sessionId))) return;
  const { error } = await tenant.db
    .from("conversations")
    .update({ browser_session: sessionId ? sealSession(browser.apiKey, conversationId, tenant.userId, sessionId) : null })
    .eq("id", conversationId)
    .eq("workspace_id", tenant.workspace.id)
    .eq("user_id", tenant.userId);
  if (error) throw new Error(error.message);
}

export type Frame = { ok: true; jpeg: Uint8Array } | { ok: false; reason: "off" | "none" | "ended" | "failed" };

/** The minimal WebSocket the CDP exchange needs (Node 22's global one; a fake in tests). */
export interface Socket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: { data?: unknown }) => void): void;
}
export type SocketFactory = (url: string) => Socket;

type Running = { ok: true; apiKey: string; sessionId: string; connectUrl: unknown } | { ok: false; reason: "off" | "none" | "ended" | "failed" };

/** The conversation's browser, if it's this member's and still running. */
async function runningSession(tenant: Tenant, conversationId: string): Promise<Running> {
  const browser = getConfig().browser;
  if (!browser) return { ok: false, reason: "off" };
  const { data, error } = await tenant.db
    .from("conversations")
    .select("browser_session")
    .eq("id", conversationId)
    .eq("workspace_id", tenant.workspace.id)
    .eq("user_id", tenant.userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const sessionId = openSession(browser.apiKey, conversationId, tenant.userId, (data as { browser_session?: string | null } | null)?.browser_session);
  if (!sessionId) return { ok: false, reason: "none" };

  let session: { status?: unknown; connectUrl?: unknown };
  try {
    const res = await fetch(`${API}/sessions/${sessionId}`, { headers: { "X-BB-API-Key": browser.apiKey }, cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (res.status === 404) return { ok: false, reason: "ended" };
    if (!res.ok) return { ok: false, reason: "failed" };
    session = (await res.json()) as typeof session;
  } catch {
    return { ok: false, reason: "failed" };
  }
  if (session.status !== "RUNNING") return { ok: false, reason: "ended" };
  return { ok: true, apiKey: browser.apiKey, sessionId, connectUrl: session.connectUrl };
}

/** One picture of what the conversation's browser shows now, or why there isn't one. */
export async function browserFrame(tenant: Tenant, conversationId: string, connect: SocketFactory = (url) => new WebSocket(url) as unknown as Socket): Promise<Frame> {
  const running = await runningSession(tenant, conversationId);
  if (!running.ok) return running;
  const { connectUrl } = running;
  if (typeof connectUrl !== "string" || !/^wss:\/\//.test(connectUrl)) return { ok: false, reason: "failed" };
  try {
    return { ok: true, jpeg: await screenshot(connectUrl, connect) };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

export type Control = { ok: true; url: string } | { ok: false; reason: "off" | "none" | "ended" | "failed" };

/**
 * A live view of the conversation's browser that the member can click and type in, open to them
 * for CONTROL_S: the page the agent is on (its last tab). Only for the member's own conversation,
 * only while its browser runs. The caller hands it to that member alone and never keeps it.
 */
export async function browserControl(tenant: Tenant, conversationId: string): Promise<Control> {
  const running = await runningSession(tenant, conversationId);
  if (!running.ok) return running;
  let live: { debuggerFullscreenUrl?: unknown; pages?: { debuggerFullscreenUrl?: unknown }[] };
  try {
    const res = await fetch(`${API}/sessions/${running.sessionId}/debug?expiresIn=${CONTROL_S}`, {
      headers: { "X-BB-API-Key": running.apiKey },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) return { ok: false, reason: "ended" };
    if (!res.ok) return { ok: false, reason: "failed" };
    live = (await res.json()) as typeof live;
  } catch {
    return { ok: false, reason: "failed" };
  }
  const pages = Array.isArray(live.pages) ? live.pages : [];
  const url = pages.at(-1)?.debuggerFullscreenUrl ?? live.debuggerFullscreenUrl;
  return typeof url === "string" && LIVE_VIEW.test(url) ? { ok: true, url } : { ok: false, reason: "failed" };
}

/**
 * One JPEG of the browser's current page over CDP: find the page (the last one open, where the
 * agent is), attach to it, capture, and close. Only read-only commands are sent.
 */
export function screenshot(url: string, connect: SocketFactory, timeoutMs = FRAME_MS): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const socket = connect(url);
    let next = 0;
    const waiting = new Map<number, (result: Record<string, unknown>) => void>();
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("timed out"))), timeoutMs);
    const call = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<Record<string, unknown>>((ok) => {
        next += 1;
        waiting.set(next, ok);
        socket.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }));
      });

    socket.addEventListener("message", (event) => {
      let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
      try {
        message = JSON.parse(String(event.data)) as typeof message;
      } catch {
        return;
      }
      if (typeof message.id !== "number") return;
      const reply = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) return finish(() => reject(new Error(message.error?.message ?? "CDP error")));
      reply?.(message.result ?? {});
    });
    socket.addEventListener("error", () => finish(() => reject(new Error("connection failed"))));
    socket.addEventListener("close", () => finish(() => reject(new Error("connection closed"))));
    socket.addEventListener("open", () => {
      void (async () => {
        const { targetInfos } = (await call("Target.getTargets")) as { targetInfos?: { targetId: string; type: string; url?: string }[] };
        const pages = (targetInfos ?? []).filter((t) => t.type === "page" && !t.url?.startsWith("devtools://"));
        const page = pages.at(-1);
        if (!page) return finish(() => reject(new Error("no page")));
        const { sessionId } = (await call("Target.attachToTarget", { targetId: page.targetId, flatten: true })) as { sessionId?: string };
        if (!sessionId) return finish(() => reject(new Error("couldn't attach")));
        const { data } = (await call("Page.captureScreenshot", { format: "jpeg", quality: 60 }, sessionId)) as { data?: string };
        if (!data) return finish(() => reject(new Error("no picture")));
        finish(() => resolve(new Uint8Array(Buffer.from(data, "base64"))));
      })().catch((e: unknown) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))));
    });
  });
}

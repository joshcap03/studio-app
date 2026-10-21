import { createHmac, timingSafeEqual } from "node:crypto";
import { getConfig } from "@/lib/config";
import type { Session } from "@/lib/tenant-core";

// The person's saved sign-ins for the agent's browser: one Browserbase context per person, shared
// by all their agents (like their connected apps). Studio Browser opens each conversation's
// browser with it and Browserbase saves it when that browser closes, so a site they signed in to
// there (filled from the secure card, or after taking the browser over) stays signed in next time. The agent never sees what
// they typed; it only browses as them afterwards, and changing anything in their accounts there
// still needs their approval.
//
// The id is kept on their account, sealed with a MAC made with the app's own Browserbase key,
// because they can write that column: an id they wrote themselves fails the check, so no one's
// browser opens with someone else's sign-ins. Forgetting deletes the context at Browserbase; the
// next run starts a fresh one. Free of next/* (runs build it).

const API = "https://api.browserbase.com/v1";
const CONTEXT_ID = /^[A-Za-z0-9_-]{8,64}$/;

function mac(apiKey: string, userId: string, contextId: string): string {
  return createHmac("sha256", apiKey).update(`studio-browser-context:${userId}:${contextId}`).digest("base64url");
}

/** The context id as stored: bound to this person by the app's own key. */
export function sealContext(apiKey: string, userId: string, contextId: string): string {
  return `${contextId}.${mac(apiKey, userId, contextId)}`;
}

/** The context id, if `sealed` is this person's; null otherwise. */
export function openContext(apiKey: string, userId: string, sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const at = sealed.lastIndexOf(".");
  const id = sealed.slice(0, at);
  if (at < 0 || !CONTEXT_ID.test(id)) return null;
  const given = Buffer.from(sealed.slice(at + 1));
  const expected = Buffer.from(mac(apiKey, userId, id));
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
}

async function stored(session: Session): Promise<string | null> {
  const { data, error } = await session.db.from("accounts").select("browser_context").eq("user_id", session.userId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { browser_context?: string | null } | null)?.browser_context ?? null;
}

/**
 * The person's saved sign-ins (a Browserbase context id), made on first use. Null when browsing
 * is off or Browserbase can't make one just now: the browser then opens without them.
 */
export async function browserContextFor(session: Session): Promise<string | null> {
  const browser = getConfig().browser;
  if (!browser) return null;
  const current = await stored(session);
  const open = openContext(browser.apiKey, session.userId, current);
  if (open) return open;

  const res = await fetch(`${API}/contexts`, {
    method: "POST",
    headers: { "X-BB-API-Key": browser.apiKey, "Content-Type": "application/json" },
    body: "{}",
    cache: "no-store",
    // Runs wait on this the first time, so it's short: without it the browser opens signed out.
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`Browserbase refused a new context (${res.status})`);
  const made = ((await res.json()) as { id?: unknown }).id;
  if (typeof made !== "string" || !CONTEXT_ID.test(made)) throw new Error("Browserbase returned no context id");
  // Only over what was read, so two first runs racing keep one context (the other is never used).
  const update = session.db.from("accounts").update({ browser_context: sealContext(browser.apiKey, session.userId, made) }).eq("user_id", session.userId);
  const { error } = await (current === null ? update.is("browser_context", null) : update.eq("browser_context", current));
  if (error) throw new Error(error.message);
  return openContext(browser.apiKey, session.userId, await stored(session));
}

/** Whether the person has saved sign-ins, or null when browsing is off. */
export async function hasSignIns(session: Session): Promise<boolean | null> {
  const browser = getConfig().browser;
  if (!browser) return null;
  return openContext(browser.apiKey, session.userId, await stored(session)) !== null;
}

/** Forgets every site the person signed in to in the agent's browser. */
export async function forgetSignIns(session: Session): Promise<void> {
  const browser = getConfig().browser;
  if (!browser) return;
  const current = await stored(session);
  const open = openContext(browser.apiKey, session.userId, current);
  if (open) {
    const res = await fetch(`${API}/contexts/${open}`, {
      method: "DELETE",
      headers: { "X-BB-API-Key": browser.apiKey },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    // Already gone counts as forgotten; anything else keeps the id so they can try again.
    if (!res.ok && res.status !== 404) throw new Error(`Browserbase couldn't forget the sign-ins (${res.status})`);
  }
  if (current !== null) {
    const { error } = await session.db.from("accounts").update({ browser_context: null }).eq("user_id", session.userId);
    if (error) throw new Error(error.message);
  }
}

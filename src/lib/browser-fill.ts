import { attachToPage, browserConnection, defaultConnect, withCdp, type CdpCall, type SocketFactory } from "@/lib/browser-view";
import type { Tenant } from "@/lib/tenant-core";
import type { SecretField } from "@/lib/types";

// Filling a login or card into the agent's browser, so the agent never sees it. The member picks
// or types it on the secure card (src/components/chat/secret-card.tsx); the server connects to the
// conversation's own browser over CDP (as watching it does, src/lib/browser-view.ts), checks which
// site the page is on, finds the fields by what they're for, and types into them as a person would
// (Input.insertText). Values go only into that connection: they're never in a script the page
// runs (except a card's expiry, picked from a menu), never returned, logged, or put in an error.
// Card numbers and security codes are masked on the page once typed, so the agent's own look at
// the page (and screenshots) can't read them back.
//
// Free of next/*.

/** How long one fill may take, start to finish. */
const FILL_MS = 20_000;
/** Frames searched for card fields besides the page itself (a checkout's payment frames). */
const MAX_FRAMES = 8;

export type FillValues = Partial<Record<SecretField, string>>;

export type FillResult =
  | { ok: true; site: string; fields: SecretField[] }
  | { ok: false; reason: "off" | "none" | "ended" | "failed" | "not_https" | "wrong_site" | "no_fields"; site?: string };

/** What each part is found by, most telling first. Roles beyond SecretField split an expiry in two. */
type Role = Exclude<SecretField, "card_expiry"> | "card_expiry" | "card_exp_month" | "card_exp_year";

/**
 * Finds the first visible, editable field for `role` in this document, focuses it (selecting
 * what's there so typing replaces it), and masks it when it holds a card's number or code. Takes
 * only the role; never a value.
 */
const FOCUS = (role: Role) => `(() => {
  const role = ${JSON.stringify(role)};
  const R = {
    username: ['input[autocomplete~="username"]', 'input[autocomplete~="email"]', 'input[type="email"]', 'input[name*="user" i]', 'input[id*="user" i]', 'input[name*="email" i]', 'input[id*="email" i]', 'input[name*="login" i]', 'input[id*="login" i]'],
    password: ['input[autocomplete~="current-password"]', 'input[type="password"]'],
    card_number: ['input[autocomplete~="cc-number"]', 'input[name*="cardnumber" i]', 'input[name*="card_number" i]', 'input[name*="card-number" i]', 'input[id*="cardnumber" i]', 'input[id*="card-number" i]', 'input[id*="card_number" i]', 'input[name*="ccnum" i]'],
    card_name: ['input[autocomplete~="cc-name"]', 'input[name*="cardholder" i]', 'input[id*="cardholder" i]', 'input[name*="nameoncard" i]', 'input[name*="card_name" i]', 'input[name*="ccname" i]'],
    card_expiry: ['input[autocomplete~="cc-exp"]', 'input[name*="exp-date" i]', 'input[name*="expiry" i]', 'input[id*="expiry" i]', 'input[name*="cardexpiry" i]', 'input[id*="exp-date" i]'],
    card_exp_month: ['[autocomplete~="cc-exp-month"]', 'select[name*="month" i]', 'input[name*="exp_month" i]', 'input[name*="expmonth" i]'],
    card_exp_year: ['[autocomplete~="cc-exp-year"]', 'select[name*="year" i]', 'input[name*="exp_year" i]', 'input[name*="expyear" i]'],
    card_code: ['input[autocomplete~="cc-csc"]', 'input[name*="cvc" i]', 'input[id*="cvc" i]', 'input[name*="cvv" i]', 'input[id*="cvv" i]', 'input[name*="csc" i]', 'input[name*="securitycode" i]'],
  };
  const skip = role === "username" ? /^(password|hidden|checkbox|radio|submit|button)$/i : /^(hidden|checkbox|radio|submit|button)$/i;
  const usable = (el) => !el.disabled && !el.readOnly && !skip.test(el.type || "") && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  for (const selector of R[role] || []) {
    for (const el of document.querySelectorAll(selector)) {
      if (!usable(el)) continue;
      el.scrollIntoView({ block: "center" });
      el.focus();
      if (role === "card_number" || role === "card_code") el.style.setProperty("-webkit-text-security", "disc", "important");
      if (el.tagName === "SELECT") return "select";
      if (typeof el.select === "function") el.select();
      return document.activeElement === el ? "input" : "unfocused";
    }
  }
  return "none";
})()`;

/** Picks a month ("04") or two-digit year ("27") in the focused menu. An expiry isn't a secret worth hiding from the page that asks for it. */
const PICK = (part: "month" | "year", value: string) => `(() => {
  const el = document.activeElement;
  if (!el || el.tagName !== "SELECT") return false;
  const want = ${JSON.stringify(part === "month" ? [value, String(Number(value))] : [value, `20${value}`])};
  const i = [...el.options].findIndex((o) => want.includes(o.value.trim()) || want.includes(o.text.trim()));
  if (i < 0) return false;
  el.selectedIndex = i;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`;

/** How long the focused field's value is now: whether typing reached it, without reading it. */
const TYPED = `(() => { const el = document.activeElement; return el && "value" in el ? String(el.value).length : -1; })()`;

async function evaluate(call: CdpCall, sessionId: string, expression: string): Promise<unknown> {
  const { result, exceptionDetails } = (await call("Runtime.evaluate", { expression, returnByValue: true }, sessionId)) as {
    result?: { value?: unknown };
    exceptionDetails?: unknown;
  };
  return exceptionDetails ? undefined : result?.value;
}

/** The order parts are filled in: as a person would, top to bottom. */
const ORDER: SecretField[] = ["username", "password", "card_name", "card_number", "card_expiry", "card_code"];

/**
 * Fills `values` into the browser's current page over CDP. The page must be https, and when
 * `origin` is given (a saved login's site) exactly that site. Login fields are looked for on the
 * page itself; card fields there and in its frames (a checkout's payment frames).
 */
export function fillPage(url: string, connect: SocketFactory, values: FillValues, { origin, timeoutMs = FILL_MS }: { origin?: string; timeoutMs?: number } = {}): Promise<FillResult> {
  return withCdp(url, connect, timeoutMs, async (call): Promise<FillResult> => {
    const page = await attachToPage(call);
    const site = await evaluate(call, page.sessionId, "location.origin");
    if (typeof site !== "string" || !site.startsWith("https://")) return { ok: false, reason: "not_https", ...(typeof site === "string" ? { site } : {}) };
    if (origin && site !== origin) return { ok: false, reason: "wrong_site", site };

    const card = Object.keys(values).some((k) => k.startsWith("card_"));
    const frames = [page.sessionId];
    if (card) {
      const { targetInfos } = (await call("Target.getTargets")) as { targetInfos?: { targetId: string; type: string }[] };
      for (const frame of (targetInfos ?? []).filter((t) => t.type === "iframe").slice(0, MAX_FRAMES)) {
        const { sessionId } = (await call("Target.attachToTarget", { targetId: frame.targetId, flatten: true })) as { sessionId?: string };
        if (sessionId) frames.push(sessionId);
      }
    }

    /** Types `text` into the first field for `role` in any frame. Whether it went in. */
    const type = async (role: Role, text: string, framesFor: string[]): Promise<boolean> => {
      for (const frame of framesFor) {
        const found = await evaluate(call, frame, FOCUS(role));
        if (found === "none" || found === undefined) continue;
        if (found === "select") {
          if (role === "card_exp_month" || role === "card_exp_year") return (await evaluate(call, frame, PICK(role === "card_exp_month" ? "month" : "year", text))) === true;
          continue;
        }
        await call("Input.insertText", { text }, frame);
        if (((await evaluate(call, frame, TYPED)) as number) > 0) return true;
        // Some frames take keyboard input only through the page that holds them.
        if (frame !== page.sessionId) {
          await call("Input.insertText", { text }, page.sessionId);
          if (((await evaluate(call, frame, TYPED)) as number) > 0) return true;
        }
      }
      return false;
    };

    const filled: SecretField[] = [];
    for (const field of ORDER) {
      const text = values[field];
      if (!text) continue;
      const where = field.startsWith("card_") ? frames : [page.sessionId];
      if (field === "card_expiry") {
        const [month, year] = text.split("/");
        if ((await type("card_expiry", text, where)) || ((await type("card_exp_month", month, where)) && (await type("card_exp_year", year, where)))) filled.push(field);
      } else if (await type(field, text, where)) {
        filled.push(field);
      }
    }
    // Leave nothing focused with a selection over what was typed.
    await evaluate(call, page.sessionId, "document.activeElement && document.activeElement.blur && document.activeElement.blur()");
    return filled.length ? { ok: true, site, fields: filled } : { ok: false, reason: "no_fields", site };
  });
}

/** Fills a login or card into the conversation's browser (see fillPage). Never throws with a value in it. */
export async function fillBrowser(tenant: Tenant, conversationId: string, values: FillValues, options: { origin?: string } = {}, connect: SocketFactory = defaultConnect): Promise<FillResult> {
  const connection = await browserConnection(tenant, conversationId);
  if (!connection.ok) return connection;
  try {
    return await fillPage(connection.url, connect, values, options);
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** The site (origin) the conversation's browser is on now, for the card to show and match saved logins against. */
export async function browserSite(tenant: Tenant, conversationId: string, connect: SocketFactory = defaultConnect): Promise<{ ok: true; site: string } | { ok: false; reason: "off" | "none" | "ended" | "failed" }> {
  const connection = await browserConnection(tenant, conversationId);
  if (!connection.ok) return connection;
  try {
    const site = await withCdp(connection.url, connect, 8000, async (call) => evaluate(call, (await attachToPage(call)).sessionId, "location.origin"));
    return typeof site === "string" && /^https?:\/\//.test(site) ? { ok: true, site } : { ok: false, reason: "failed" };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** One thing the member does in the browser while taking it over. Points are fractions of the picture (0–1). */
export type DriveInput =
  | { type: "click"; x: number; y: number }
  | { type: "text"; text: string }
  | { type: "key"; key: DriveKey }
  | { type: "scroll"; x: number; y: number; dy: number };

export const DRIVE_KEYS = ["Enter", "Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const;
export type DriveKey = (typeof DRIVE_KEYS)[number];

const KEY_CODES: Record<DriveKey, number> = { Enter: 13, Tab: 9, Backspace: 8, Escape: 27, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };

/**
 * Passes one click, key, scroll, or bit of typing to the browser's current page, as the member
 * did it on the picture. What they type goes only into the connection: it's never logged or kept.
 */
export function drivePage(url: string, connect: SocketFactory, input: DriveInput, timeoutMs = 8000): Promise<void> {
  return withCdp(url, connect, timeoutMs, async (call) => {
    const { sessionId } = await attachToPage(call);
    if (input.type === "text") {
      await call("Input.insertText", { text: input.text }, sessionId);
      return;
    }
    if (input.type === "key") {
      const code = KEY_CODES[input.key];
      const base = { key: input.key, code: input.key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
      await call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, ...(input.key === "Enter" ? { text: "\r" } : {}) }, sessionId);
      if (input.key === "Enter") await call("Input.dispatchKeyEvent", { type: "char", ...base, text: "\r" }, sessionId);
      await call("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
      return;
    }
    const size = await evaluate(call, sessionId, "[innerWidth, innerHeight]");
    const [width, height] = Array.isArray(size) ? (size as number[]) : [1280, 720];
    const x = Math.round(input.x * width);
    const y = Math.round(input.y * height);
    if (input.type === "scroll") {
      await call("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: input.dy }, sessionId);
      return;
    }
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
    await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
  });
}

/** Drives the conversation's browser for the member taking it over (see drivePage). */
export async function driveBrowser(tenant: Tenant, conversationId: string, input: DriveInput, connect: SocketFactory = defaultConnect): Promise<{ ok: true } | { ok: false; reason: "off" | "none" | "ended" | "failed" }> {
  const connection = await browserConnection(tenant, conversationId);
  if (!connection.ok) return connection;
  try {
    await drivePage(connection.url, connect, input);
    return { ok: true };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

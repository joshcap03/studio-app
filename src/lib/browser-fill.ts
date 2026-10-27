import { attachToPage, browserConnection, defaultConnect, withCdp, type CdpCall, type SocketFactory } from "@/lib/browser-view";
import type { Tenant } from "@/lib/tenant-core";
import type { DriveKey, SecretField, ShownStep } from "@/lib/types";

// Filling a login, card, or one-time code into the agent's browser, so the agent never sees it. The member picks
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
    one_time_code: ['input[autocomplete~="one-time-code"]', 'input[name*="otp" i]', 'input[id*="otp" i]', 'input[name*="mfa" i]', 'input[id*="mfa" i]', 'input[name*="2fa" i]', 'input[id*="2fa" i]', 'input[name*="verif" i]', 'input[id*="verif" i]', 'input[name*="passcode" i]', 'input[name*="token" i]', 'input[name*="code" i]', 'input[id*="code" i]', 'input[inputmode="numeric"]'],
  };
  const skip = role === "username" ? /^(password|hidden|checkbox|radio|submit|button)$/i : /^(hidden|checkbox|radio|submit|button)$/i;
  // A code field's name can be another kind of code: a postcode, a promo code, a phone's area code.
  const notCode = /zip|postal|post_?code|promo|coupon|discount|gift|country|area|phone/i;
  const usable = (el) => !el.disabled && !el.readOnly && !skip.test(el.type || "") && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" &&
    !(role === "one_time_code" && notCode.test((el.name || "") + " " + (el.id || "")));
  for (const selector of R[role] || []) {
    for (const el of document.querySelectorAll(selector)) {
      if (!usable(el)) continue;
      el.scrollIntoView({ block: "center" });
      el.focus();
      if (role === "card_number" || role === "card_code") el.style.setProperty("-webkit-text-security", "disc", "important");
      if (el.tagName === "SELECT") return "select";
      // A code split into one box per character.
      if (role === "one_time_code" && el.maxLength === 1) return "split";
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

/** Focuses box `i` of a code split into one-character boxes (they move on by themselves on most pages, not all). */
const CODE_BOX = (i: number) => `(() => {
  const box = ${i};
  const boxes = [...document.querySelectorAll("input")].filter((el) => el.maxLength === 1 && !el.disabled && !el.readOnly && el.type !== "hidden" && el.getClientRects().length > 0);
  const el = boxes[box];
  if (!el) return false;
  el.focus();
  if (typeof el.select === "function") el.select();
  return document.activeElement === el;
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
const ORDER: SecretField[] = ["username", "password", "card_name", "card_number", "card_expiry", "card_code", "one_time_code"];

/**
 * Fills `values` into the browser's current page over CDP. The page must be https, and when
 * `origin` is given (a saved login's site) exactly that site. Login and code fields are looked for on the
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
        if (found === "split") {
          // One character per box, in order; it went in if the last box took its character.
          const chars = [...text];
          let all = true;
          for (const [i, char] of chars.entries()) {
            if ((await evaluate(call, frame, CODE_BOX(i))) !== true) {
              all = false;
              break;
            }
            await call("Input.insertText", { text: char }, frame);
          }
          if (all && ((await evaluate(call, frame, TYPED)) as number) > 0) return true;
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

/** Fills a login, card, or code into the conversation's browser (see fillPage). Never throws with a value in it. */
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
  | { type: "scroll"; x: number; y: number; dy: number }
  /** Nothing done: only where the page is, for a showing's start and end. */
  | { type: "look" };

const KEY_CODES: Record<DriveKey, number> = { Enter: 13, Tab: 9, Backspace: 8, Escape: 27, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };

// Showing the agent a job ("Show me once"): before each input, the page is asked what it's
// about to act on, by the names a person sees (a button's words, a field's label), so the agent
// learns what they meant rather than where they clicked. These read names and attributes only,
// never a field's value; what was typed comes from the input itself, and only into a field that
// isn't a password, card, or code.

/** A readable name for an element, as a person would call it: its label, words, or hint. */
const NAMING = `
  const squash = (t) => String(t || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  const nameOf = (el) => {
    if (!el || el.nodeType !== 1) return "";
    const by = el.getAttribute("aria-labelledby");
    const labelled = by ? by.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ") : "";
    const tag = el.tagName;
    const field = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    return squash(
      el.getAttribute("aria-label") || labelled || (field && el.labels && el.labels[0] ? el.labels[0].innerText : "") ||
      (field ? el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "" : "") ||
      (tag === "IMG" ? el.getAttribute("alt") : "") ||
      (tag === "INPUT" && /^(submit|button)$/i.test(el.type) ? el.getAttribute("value") : "") ||
      el.innerText || el.getAttribute("title") || el.getAttribute("alt") || ""
    );
  };
  const kindOf = (el) => {
    const role = el.getAttribute("role");
    if (role) return role === "textbox" || role === "searchbox" ? "field" : role;
    const tag = el.tagName;
    if (tag === "A") return "link";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return "menu";
    if (tag === "TEXTAREA") return "field";
    if (tag === "INPUT") return /^(submit|button|reset)$/i.test(el.type) ? "button" : /^(checkbox|radio)$/i.test(el.type) ? el.type : "field";
    if (tag === "IFRAME") return "frame";
    return "";
  };
  const page = { title: squash(document.title), url: (location.origin + location.pathname).slice(0, 160) };
`;

/** What's at (x, y) in the viewport, as a person would name it, and the page it's on. */
const DESCRIBE_AT = (x: number, y: number) => `(() => {${NAMING}
  const hit = document.elementFromPoint(${x}, ${y});
  const el = hit && hit.closest('a,button,input,select,textarea,label,summary,iframe,[role=button],[role=link],[role=tab],[role=option],[role=menuitem],[role=checkbox],[role=radio],[role=combobox],[role=switch],[role=textbox],[role=searchbox]');
  if (!el) {
    // Nothing to press: the words there, if it's a short bit of text, else just the page.
    const words = hit && hit !== document.body && hit !== document.documentElement ? String(hit.innerText || "").replace(/\\s+/g, " ").trim() : "";
    return { page, target: words && words.length <= 60 ? "\u201c" + words + "\u201d" : "the page" };
  }
  const kind = kindOf(el);
  const name = nameOf(el);
  // A name the page repeats ("Add to cart" on every row) says which one by the row it's in.
  let row = "";
  if (name && [...document.querySelectorAll(el.tagName)].some((o) => o !== el && nameOf(o) === name)) {
    for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
      const words = String(up.innerText || "").replace(name, " ").replace(/\\s+/g, " ").trim();
      if (!words) continue;
      if (words.length <= 120) row = squash(words);
      break;
    }
  }
  const named = [kind, name ? "\\u201c" + name + "\\u201d" : ""].filter(Boolean).join(" ");
  return { page, target: (named ? named + (row ? " next to \\u201c" + row + "\\u201d" : "") : "") || "the page" };
})()`;

/** The field that has focus, by name, and whether what goes in it must not be kept. */
const DESCRIBE_FOCUSED = `(() => {${NAMING}
  let el = document.activeElement;
  while (el && el.tagName === "IFRAME") { try { el = el.contentDocument.activeElement; } catch { break; } }
  if (!el || el === document.body) return { page, sensitive: false };
  const name = nameOf(el);
  const hints = [el.getAttribute("autocomplete"), el.getAttribute("name"), el.id, el.getAttribute("inputmode"), name].join(" ");
  const sensitive = el.tagName === "IFRAME" || el.type === "password" ||
    getComputedStyle(el).getPropertyValue("-webkit-text-security") === "disc" ||
    /cc-|one-time-code|password|pass(word|code)?\\b|pwd|card.?(number|num|no)|cvc|cvv|csc|security.?code|ssn|social.?security|\\botp\\b|\\bpin\\b|verification.?code|2fa|mfa/i.test(hints);
  return { page, target: [kindOf(el) || "field", name ? "\\u201c" + name + "\\u201d" : ""].filter(Boolean).join(" "), sensitive };
})()`;

/** Text that looks like a card, account, or ID number (nine or more digits), kept out like a password field's. */
const NUMBERISH = /(?:\d[\s-]?){9,}/;

const asPage = (raw: unknown): ShownStep["page"] => {
  const page = (raw && typeof raw === "object" ? raw : {}) as { title?: unknown; url?: unknown };
  const text = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
  return { title: text(page.title, 80), url: text(page.url, 160) };
};

/**
 * Passes one click, key, scroll, or bit of typing to the browser's current page, as the member
 * did it on the picture. What they type goes only into the connection: it's never logged or kept.
 * With `record` (they're showing the agent a job), it says what the input was done to first, as
 * a step; typing into a password, card, or code field is a step without the text.
 */
export function drivePage(url: string, connect: SocketFactory, input: DriveInput, { timeoutMs = 8000, record = false }: { timeoutMs?: number; record?: boolean } = {}): Promise<ShownStep | null> {
  return withCdp(url, connect, timeoutMs, async (call) => {
    const { sessionId } = await attachToPage(call);
    const at = Date.now();
    const focused = async () => {
      const seen = (await evaluate(call, sessionId, DESCRIBE_FOCUSED)) as { page?: unknown; target?: unknown; sensitive?: unknown } | undefined;
      return { page: asPage(seen?.page), target: typeof seen?.target === "string" && seen.target ? seen.target : undefined, sensitive: seen?.sensitive !== false };
    };
    if (input.type === "look") {
      if (!record) return null;
      return { at, action: "look", page: (await focused()).page };
    }
    if (input.type === "text") {
      const field = record ? await focused() : null;
      await call("Input.insertText", { text: input.text }, sessionId);
      if (!field) return null;
      const hidden = field.sensitive || NUMBERISH.test(input.text);
      return { at, action: "type", page: field.page, ...(field.target ? { target: field.target } : {}), ...(hidden ? { hidden: true } : { text: input.text }) };
    }
    if (input.type === "key") {
      const field = record ? await focused() : null;
      const code = KEY_CODES[input.key];
      const base = { key: input.key, code: input.key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
      await call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, ...(input.key === "Enter" ? { text: "\r" } : {}) }, sessionId);
      if (input.key === "Enter") await call("Input.dispatchKeyEvent", { type: "char", ...base, text: "\r" }, sessionId);
      await call("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
      return field ? { at, action: "key", key: input.key, page: field.page, ...(field.target ? { target: field.target } : {}) } : null;
    }
    const size = await evaluate(call, sessionId, "[innerWidth, innerHeight]");
    const [width, height] = Array.isArray(size) ? (size as number[]) : [1280, 720];
    const x = Math.round(input.x * width);
    const y = Math.round(input.y * height);
    if (input.type === "scroll") {
      const seen = record ? asPage(((await evaluate(call, sessionId, `(() => {${NAMING} return { page }; })()`)) as { page?: unknown } | undefined)?.page) : null;
      await call("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: input.dy }, sessionId);
      return seen ? { at, action: "scroll", page: seen, dy: input.dy } : null;
    }
    const seen = record ? ((await evaluate(call, sessionId, DESCRIBE_AT(x, y))) as { page?: unknown; target?: unknown } | undefined) : null;
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
    await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
    if (!record) return null;
    return { at, action: "click", page: asPage(seen?.page), ...(typeof seen?.target === "string" && seen.target ? { target: seen.target.slice(0, 200) } : {}) };
  });
}

/** Drives the conversation's browser for the member taking it over (see drivePage), with the step it was when `record`. */
export async function driveBrowser(
  tenant: Tenant,
  conversationId: string,
  input: DriveInput,
  { record = false }: { record?: boolean } = {},
  connect: SocketFactory = defaultConnect,
): Promise<{ ok: true; step: ShownStep | null } | { ok: false; reason: "off" | "none" | "ended" | "failed" }> {
  const connection = await browserConnection(tenant, conversationId);
  if (!connection.ok) return connection;
  try {
    return { ok: true, step: await drivePage(connection.url, connect, input, { record }) };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

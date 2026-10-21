import type { ApprovalAction } from "@/lib/agent/types";
import { isRecord, maskSecrets } from "@/lib/agent/tools/sanitize";
import type { TapOnlyReason } from "@/lib/types";
import { plain, TECHNICAL } from "@/lib/voice/relay";

// Whether a request the agent paused on may be approved by voice on a call, decided once, when
// it asks, from what approving it would run (the adapter's `actions`, with their raw arguments),
// never from the agent's own summary of it. Fails closed: only a few kinds of action Studio can
// read back plainly from their arguments are voice-ok (an email to at most five people, a
// draft, a calendar event), and everything else is a tap, with the reason when there is one:
// money, deletions, sends to more than five people or posts to many, or "unsupported". Also
// builds the read-back, the words the call says before a yes counts. Pure.

export type SpokenApproval =
  | { voiceOk: true; readBack: string; tools: string[] }
  | { voiceOk: false; tapOnly: TapOnlyReason; tools: string[] };

/** The longest read-back: said whole, with the "send it" prompt after it, in one line. */
export const MAX_READ_BACK = 400;
/** More recipients than this is a bulk send, a tap. */
export const MAX_SPOKEN_RECIPIENTS = 5;
/** What the approvals.tools column holds at most: this many names, joined with commas in at most MAX_TOOLS_CHARS. */
export const MAX_TOOLS = 10;
export const MAX_TOOLS_CHARS = 1000;

const COMPOSIO_SLUG = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;
/** The summary when the agent gave none: there's nothing of its own to check the action against. */
const FALLBACK_SUMMARY = /^(tool execution requires approval|the agent wants to make a change)/i;

// Apps that move money whatever they're asked to do, and words in an action's name that do.
const MONEY_TOOLKITS =
  /^(STRIPE|QUICKBOOKS|SHOPIFY|PAYPAL|SQUARE|SQUAREUP|XERO|FRESHBOOKS|WAVE|BRAINTREE|CHARGEBEE|RECURLY|PLAID|WISE|BREX|RAMP|MERCURY|GUSTO|COINBASE|ZOHO_BOOKS|ZOHO_INVOICE|ADYEN|PADDLE|LEMONSQUEEZY|GOCARDLESS|VENMO|REVOLUT|PAYONEER|KLARNA|BILLCOM|EXPENSIFY|ZUORA|NETSUITE|SAGE)_/;
const MONEY_WORDS = new Set([
  "PAY", "PAYS", "PAYMENT", "PAYMENTS", "CHARGE", "CHARGES", "REFUND", "REFUNDS", "TRANSFER", "TRANSFERS", "PAYOUT", "PAYOUTS",
  "INVOICE", "INVOICES", "PURCHASE", "BUY", "CHECKOUT", "ORDER", "ORDERS", "SUBSCRIPTION", "SUBSCRIPTIONS", "BILLING", "BILL",
  "BILLS", "WITHDRAW", "WITHDRAWAL", "DEPOSIT", "CAPTURE", "PAYROLL", "DONATE", "WIRE", "SPEND",
]);
const DELETE_WORDS = new Set([
  "DELETE", "DELETES", "REMOVE", "TRASH", "PURGE", "DESTROY", "ERASE", "CLEAR", "EMPTY", "DROP", "REVOKE", "CANCEL", "ARCHIVE",
  "UNSUBSCRIBE", "UNSHARE", "REPLACE", "OVERWRITE", "WIPE",
]);
// Sending to many at once, or posting where many can see it.
const BROADCAST_WORDS = new Set(["PUBLISH", "SHARE", "SHARING", "BROADCAST", "CAMPAIGN", "CAMPAIGNS", "BULK", "MASS", "BLAST", "POST", "TWEET"]);
const BROADCAST_TOOLKITS =
  /^(MAILCHIMP|SENDGRID|KLAVIYO|BREVO|SENDINBLUE|CONSTANTCONTACT|CONVERTKIT|MAILGUN|MAILERLITE|ACTIVECAMPAIGN|TWITTER|LINKEDIN|INSTAGRAM|FACEBOOK|TIKTOK|YOUTUBE|REDDIT|THREADS|BLUESKY|MASTODON|DISCORD)_/;
// Slack messages reach a channel unless sent to a direct-message one (its id starts with D).
const CHAT_TOOLKITS = /^(SLACK|SLACKBOT)_/;
const CHAT_SEND = new Set(["SEND", "POST", "CHAT", "MESSAGE", "REPLY"]);

/** The kinds of action that can be approved by voice, each read back its own way. */
type Shape = "email" | "reply" | "forward" | "draft" | "event" | "quick_event";

// Every word of a voice-ok action's name is one of these, so a new or unexpected action with a
// familiar verb in it ("GMAIL_SEND_EMAIL_TO_LABEL") still isn't one.
const MAIL_WORDS = new Set(["SEND", "REPLY", "FORWARD", "EMAIL", "MAIL", "MESSAGE", "TO", "THREAD", "OUTLOOK", "NEW", "A"]);
const DRAFT_WORDS = new Set(["CREATE", "DRAFT", "EMAIL", "MAIL", "MESSAGE", "OUTLOOK", "NEW", "REPLY", "A", "AN"]);
const EVENT_WORDS = new Set(["CREATE", "EVENT", "CALENDAR", "OUTLOOK", "NEW", "AN"]);

function shapeOf(slug: string): Shape | null {
  const [toolkit, ...rest] = slug.split("_");
  const words = new Set(rest);
  const only = (allowed: Set<string>) => rest.length > 0 && rest.every((w) => allowed.has(w));
  if (toolkit === "GMAIL" || toolkit === "OUTLOOK") {
    if (words.has("DRAFT") && !words.has("SEND") && only(DRAFT_WORDS)) return "draft";
    const verbs = (["SEND", "REPLY", "FORWARD"] as const).filter((v) => words.has(v));
    if (!words.has("DRAFT") && only(MAIL_WORDS) && verbs.length === 1) return verbs[0] === "SEND" ? "email" : verbs[0] === "REPLY" ? "reply" : "forward";
  }
  if ((toolkit === "GOOGLECALENDAR" || toolkit === "OUTLOOK") && only(EVENT_WORDS) && words.has("CREATE") && words.has("EVENT")) return "event";
  if (toolkit === "GOOGLECALENDAR" && rest.join("_") === "QUICK_ADD") return "quick_event";
  return null;
}

const tokens = (slug: string) => slug.split("_");

// Words in a browser step's instruction that pay ("click Place order", "press Pay now").
const BROWSER_MONEY_WORDS = new Set([...MONEY_WORDS, "SUBSCRIBE", "DONATE", "TIP", "CART", "BOOK", "RESERVE", "UPGRADE", "RENEW", "PAID", "PLACE"]);

function moves(action: ApprovalAction): boolean {
  if (action.tool === "act") {
    // A step in the agent's browser pays when its instruction says so, whatever page it's on.
    const words = JSON.stringify(action.arguments ?? "").toUpperCase().match(/[A-Z]+/g) ?? [];
    return words.some((w) => BROWSER_MONEY_WORDS.has(w));
  }
  return COMPOSIO_SLUG.test(action.tool) && (MONEY_TOOLKITS.test(action.tool) || tokens(action.tool).some((t) => MONEY_WORDS.has(t)));
}

function deletes(action: ApprovalAction): boolean {
  if (!COMPOSIO_SLUG.test(action.tool)) return false;
  const words = tokens(action.tool);
  if (words.some((t) => DELETE_WORDS.has(t))) return true;
  // A batch of edits can carry deletions in its requests (Sheets' deleteDimension, Docs' deleteContentRange).
  return words.includes("BATCH") && /delete|remove|clear/i.test(JSON.stringify(action.arguments ?? null));
}

function broadcasts(action: ApprovalAction): boolean {
  if (!COMPOSIO_SLUG.test(action.tool)) return false;
  if (BROADCAST_TOOLKITS.test(action.tool) || tokens(action.tool).some((t) => BROADCAST_WORDS.has(t))) return true;
  if (CHAT_TOOLKITS.test(action.tool) && tokens(action.tool).some((t) => CHAT_SEND.has(t))) {
    const channel = isRecord(action.arguments) ? (action.arguments.channel ?? action.arguments.channel_id) : undefined;
    return !(typeof channel === "string" && /^D[A-Z0-9]+$/.test(channel));
  }
  return false;
}

/**
 * What approving `actions` would do, as far as a call may approve it: voice-ok with its
 * read-back, or why it's a tap. `summary` is the agent's own line for the card, which only has
 * to exist; nothing is read from it.
 */
export function spokenApprovalFor({ actions, summary }: { actions?: ApprovalAction[]; summary: string }): SpokenApproval {
  const list = actions ?? [];
  const tools = fitTools(list.map((a) => a.tool));
  const tap = (tapOnly: TapOnlyReason): SpokenApproval => ({ voiceOk: false, tapOnly, tools });
  // The classes hold across everything one approval covers: a payment anywhere in it makes it one.
  if (list.some(moves)) return tap("money");
  if (list.some(deletes)) return tap("deletion");
  if (list.some(broadcasts)) return tap("bulk_send");
  // Everyone it reaches, including addresses under keys Studio doesn't know as recipients.
  const sent = new Set(
    list.flatMap((a) => {
      if (COMPOSIO_SLUG.test(a.tool) && shapeOf(a.tool) === "draft") return [];
      const people = recipientsOf(a.arguments);
      return [...people.all, ...people.stray];
    }),
  );
  if (sent.size > MAX_SPOKEN_RECIPIENTS) return tap("bulk_send");
  // One action, of a kind Studio can read back, that the agent described.
  if (list.length !== 1 || FALLBACK_SUMMARY.test(summary.trim())) return tap("unsupported");
  const [action] = list;
  const shape = COMPOSIO_SLUG.test(action.tool) ? shapeOf(action.tool) : null;
  if (!shape || !isRecord(action.arguments)) return tap("unsupported");
  const people = recipientsOf(action.arguments);
  // A name with no address could be a group or a list, and an address under a key Studio doesn't
  // know could be anyone it reaches: either way, who it reaches can't be read back.
  if (people.unknown || people.stray.length) return tap("unsupported");
  // An event is read back from its arguments in full or not at all: a repeat, a meeting room, a
  // calendar other than the member's own, anything Studio wouldn't say, makes it a tap.
  if ((shape === "event" || shape === "quick_event") && !onlyEventArgs(shape, action.arguments)) return tap("unsupported");
  // A reply or send with nobody named could go to a whole thread.
  if ((shape === "email" || shape === "reply" || shape === "forward") && !people.to.length) return tap("unsupported");
  const readBack = readBackFor(shape, action.arguments, people);
  return readBack ? { voiceOk: true, readBack, tools } : tap("unsupported");
}

/** The tool names kept with a request, clipped so they always fit the column (MAX_TOOLS, MAX_TOOLS_CHARS). */
export function fitTools(names: string[]): string[] {
  const kept: string[] = [];
  let chars = 0;
  for (const name of names) {
    const clipped = name.slice(0, 100);
    if (!clipped) continue;
    const next = chars + (kept.length ? 1 : 0) + clipped.length;
    if (kept.length >= MAX_TOOLS || next > MAX_TOOLS_CHARS) break;
    kept.push(clipped);
    chars = next;
  }
  return kept;
}

// ------------------------------------------------------------------------------------------
// Who it reaches

interface People {
  to: string[];
  cc: string[];
  bcc: string[];
  /** Everyone, once each. */
  all: string[];
  /** A recipient was named without an address, or the arguments nest too deep to read. */
  unknown: boolean;
  /**
   * Addresses anywhere else in the arguments (under a key not known as a recipient's, outside
   * the sender's and the quoted text), not among `all`: they may be reached, so it fails closed.
   */
  stray: string[];
}

const EMAIL = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const CC_KEY = /^cc(_(emails?|recipients?|list|addresses))?$/;
const BCC_KEY = /^bcc(_(emails?|recipients?|list|addresses))?$/;
const TO_KEY =
  /^(to|to_(emails?|recipients?|addresses|list)|send_to|recipient|recipients|recipient_(emails?|email_address(es)?|list|addresses)|extra_recipients|emails?|email_addresses|(optional_|required_)?attendees?|attendees?_(info|list|emails?|addresses)|participants?|participants?_(emails?|list)|invitees?|invitees?_(emails?|list)|invite_(emails?|list)|guests?|guests?_(emails?|list))$/;
// The member's own account, never a recipient: an address there isn't someone it reaches.
const SENDER_KEY = /^(from|from_(email|address|name)|sender|sender_(email|address|name)|user_id|organizer|organizer_email)$/;
// Quoted text (said, or not, as the read-back decides): an address written in it isn't sent to.
const TEXT_KEY = /^(message_body|body|html_body|text|content|message|additional_text|comment|subject|summary|title|name|description|location|notes)$/;
/** Deeper than this, arguments aren't read: an action nesting them so is a tap. */
const MAX_DEPTH = 10;

function snake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase();
}

/** Every recipient an action's arguments name, by where they go, however deeply they're nested. */
export function recipientsOf(args: unknown): People {
  const people: People = { to: [], cc: [], bcc: [], all: [], unknown: false, stray: [] };
  const add = (list: string[], value: unknown, depth: number) => {
    if (depth > MAX_DEPTH) {
      people.unknown = true;
      return;
    }
    if (typeof value === "string") {
      const found = value.match(EMAIL) ?? [];
      if (!found.length && value.trim()) people.unknown = true;
      for (const e of found) list.push(e.toLowerCase());
    } else if (Array.isArray(value)) {
      for (const v of value) add(list, v, depth + 1);
    } else if (isRecord(value)) {
      // {email}, {emailAddress: {address, name}}: the address, not the name beside it.
      const addresses = Object.entries(value).filter(([k]) => /email|address/i.test(k));
      if (!addresses.length) people.unknown = true;
      for (const [, v] of addresses) add(list, v, depth + 1);
    } else if (value != null && value !== false) {
      people.unknown = true;
    }
  };
  // Addresses anywhere that isn't a recipient's, the sender's, or quoted text.
  const elsewhere: string[] = [];
  const walk = (value: unknown, key: string | null, depth: number) => {
    if (depth > MAX_DEPTH) {
      people.unknown = true;
      return;
    }
    if (typeof value === "string") {
      if (key !== null && (SENDER_KEY.test(key) || TEXT_KEY.test(key))) return;
      for (const e of value.match(EMAIL) ?? []) elsewhere.push(e.toLowerCase());
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v) => walk(v, key, depth + 1));
      return;
    }
    if (!isRecord(value)) return;
    for (const [rawKey, v] of Object.entries(value)) {
      const k = snake(rawKey);
      if (CC_KEY.test(k)) add(people.cc, v, 0);
      else if (BCC_KEY.test(k)) add(people.bcc, v, 0);
      else if (TO_KEY.test(k)) add(people.to, v, 0);
      else walk(v, k, depth + 1);
    }
  };
  walk(args, null, 0);
  const once = (list: string[]) => [...new Set(list)];
  people.to = once(people.to);
  people.cc = once(people.cc).filter((e) => !people.to.includes(e));
  people.bcc = once(people.bcc).filter((e) => !people.to.includes(e) && !people.cc.includes(e));
  people.all = [...people.to, ...people.cc, ...people.bcc];
  people.stray = once(elsewhere).filter((e) => !people.all.includes(e));
  return people;
}

// ------------------------------------------------------------------------------------------
// What an event's arguments may hold

const END_KEYS = ["end_datetime", "end_date_time", "end_time", "end", "end_date", "ends_at"];
const HOUR_KEYS = ["event_duration_hour", "event_duration_hours", "duration_hours"];
const MINUTE_KEYS = ["event_duration_minutes", "event_duration_minute", "duration_minutes"];
const ZONE_KEYS = ["timezone", "time_zone"];
// What a nested {start: {...}} may hold.
const TIME_KEYS = new Set(["date_time", "datetime", "date", "time_zone", "timezone"]);
// Said in the read-back, or changes nothing it says: the rest of an event's arguments make it a tap.
const EVENT_ARG_KEYS = new Set([
  ...["summary", "title", "subject", "name"],
  ...["start_datetime", "start_date_time", "start_time", "start", "start_date", "starts_at"],
  ...END_KEYS,
  ...HOUR_KEYS,
  ...MINUTE_KEYS,
  ...ZONE_KEYS,
  ...["description", "body", "is_html", "location", "send_updates", "calendar_id", "user_id"],
]);
const QUICK_EVENT_ARG_KEYS = new Set(["text", "calendar_id", "send_updates", "user_id"]);
const REPEATS_KEY = /recurr|rrule|repeat/;

const empty = (v: unknown) => v == null || v === "" || v === false || (Array.isArray(v) && v.length === 0) || (isRecord(v) && Object.keys(v).length === 0);

/** A repeat anywhere in the arguments, however it's keyed or nested. */
function repeats(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true;
  if (Array.isArray(value)) return value.some((v) => repeats(v, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([k, v]) => (REPEATS_KEY.test(snake(k)) && !empty(v)) || repeats(v, depth + 1));
}

/**
 * Whether every argument of an event is one the read-back says, or one that changes nothing it
 * says (a description, the member's own primary calendar). Anything else (a repeat, a meeting
 * room, visibility, another calendar) fails closed.
 */
function onlyEventArgs(shape: "event" | "quick_event", args: Record<string, unknown>): boolean {
  if (repeats(args)) return false;
  const allowed = shape === "event" ? EVENT_ARG_KEYS : QUICK_EVENT_ARG_KEYS;
  return Object.entries(args).every(([rawKey, v]) => {
    const k = snake(rawKey);
    if (empty(v)) return true;
    // Who's invited is checked, and read back, on its own.
    if (TO_KEY.test(k) || CC_KEY.test(k) || BCC_KEY.test(k)) return shape === "event";
    if (!allowed.has(k)) return false;
    if (k === "calendar_id") return typeof v === "string" && v.trim().toLowerCase() === "primary";
    if (k === "user_id") return typeof v === "string" && v.trim().toLowerCase() === "me";
    if (k === "send_updates" || k === "is_html") return typeof v === "boolean" || (typeof v === "string" && /^(all|none|true|false|external_only|externalonly)$/i.test(v.trim()));
    if (isRecord(v)) return Object.entries(v).every(([inner, w]) => empty(w) || TIME_KEYS.has(snake(inner)));
    return typeof v === "string" || typeof v === "number";
  });
}

// ------------------------------------------------------------------------------------------
// The read-back

const MAX_EXCERPT = 140;
const BODY_KEYS = ["message_body", "body", "html_body", "text", "content", "message", "additional_text", "comment"];
const SUBJECT_KEYS = ["subject"];
const TITLE_KEYS = ["summary", "title", "subject", "name"];
const START_KEYS = ["start_datetime", "start_date_time", "start_time", "start", "start_date", "starts_at"];
const ATTACHMENT_KEY = /^(attachments?|files?)$/;

function field(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const entry = Object.entries(args).find(([k]) => snake(k) === key);
    const value = entry?.[1];
    if (typeof value === "string" && value.trim()) return value;
    // Calendar APIs nest the time: {start: {dateTime}}.
    if (isRecord(value)) {
      const inner = value.dateTime ?? value.date_time ?? value.date;
      if (typeof inner === "string" && inner.trim()) return inner;
    }
  }
  return null;
}

/** Text from an action's arguments, cleaned for the ear: no markup, links, symbols, or quotes, at most `max` characters. Null when nothing's left or it hides a secret. */
function words(value: string | null, max: number): string | null {
  if (!value) return null;
  const masked = maskSecrets(value);
  if (masked !== value) return null;
  const text = plain(value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;|&apos;/gi, "'"))
    .replace(/[{}<>[\]`|"“”]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : text;
}

/** The body's opening sentence, without its closing mark (the read-back closes it). */
function excerpt(args: Record<string, unknown>, max: number): string | null {
  const body = words(field(args, BODY_KEYS), 2000);
  // A sentence ends at a stop before a space, so an address (jo@acme.example) or $1.50 isn't cut.
  const first = body?.split(/(?<=[.!?])\s+/)[0];
  return first ? words(first.replace(/[.!?]+$/, ""), max) : null;
}

function names(list: string[]): string {
  const shown = list.length > MAX_SPOKEN_RECIPIENTS ? [...list.slice(0, 3), `${list.length - 3} more`] : list;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : (shown[0] ?? "");
}

function copies(people: People): string {
  return `${people.cc.length ? `, cc ${names(people.cc)}` : ""}${people.bcc.length ? `, bcc ${names(people.bcc)}` : ""}`;
}

function attachments(args: Record<string, unknown>): string {
  const files = Object.entries(args)
    .filter(([k, v]) => ATTACHMENT_KEY.test(snake(k)) && v != null && v !== "" && !(Array.isArray(v) && !v.length))
    .flatMap(([, v]) => (Array.isArray(v) ? v : [v]));
  return files.length === 0 ? "" : files.length === 1 ? ", with an attachment" : `, with ${files.length} attachments`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * A time as written in the event's own clock ("2026-10-21T15:30:00"), said plainly ("October 21,
 * 2026 at 3:30 PM"). Null for anything more: a trailing Z or offset puts it in a zone the
 * read-back wouldn't say, so it isn't said at all.
 */
export function spokenWhen(value: string | null): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(value?.trim() ?? "");
  if (!m) return null;
  const [, year, month, day, hour, minute] = m;
  const monthName = MONTHS[Number(month) - 1];
  if (!monthName || Number(day) < 1 || Number(day) > 31) return null;
  const date = `${monthName} ${Number(day)}, ${year}`;
  if (hour === undefined) return date;
  const h = Number(hour);
  if (h > 23 || Number(minute) > 59) return null;
  const clock = `${h % 12 === 0 ? 12 : h % 12}${minute === "00" ? "" : `:${minute}`} ${h < 12 ? "AM" : "PM"}`;
  return `${date} at ${clock}`;
}

/** A time zone as said aloud ("America/New_York" is "New York time"); null when it can't be said plainly. */
export function spokenZone(zone: string): string | null {
  const z = zone.trim();
  if (/^(utc|gmt|etc\/utc|etc\/gmt|z)$/i.test(z)) return "UTC";
  if (!/^[A-Za-z]+(?:\/[A-Za-z][A-Za-z_-]*){1,2}$/.test(z)) return null;
  const city = z.split("/").at(-1)!.replace(/[_-]+/g, " ");
  return `${city} time`;
}

/** Every time zone an event's arguments give, top level or nested in its start or end. Null when one isn't text. */
function zonesOf(args: Record<string, unknown>): string[] | null {
  const zones: unknown[] = [];
  for (const [k, v] of Object.entries(args)) {
    const key = snake(k);
    if (ZONE_KEYS.includes(key)) zones.push(v);
    if (isRecord(v)) for (const [inner, w] of Object.entries(v)) if (ZONE_KEYS.includes(snake(inner))) zones.push(w);
  }
  const given = zones.filter((z) => !empty(z));
  if (given.some((z) => typeof z !== "string")) return null;
  return [...new Set((given as string[]).map((z) => z.trim()))];
}

function count(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : null;
}

/** How long it runs, from its own duration fields: "an hour and 30 minutes". Undefined when none is given, null when one can't be said. */
function spokenDuration(args: Record<string, unknown>): string | null | undefined {
  const rawHours = HOUR_KEYS.map((k) => Object.entries(args).find(([key]) => snake(key) === k)?.[1]).find((v) => !empty(v));
  const rawMinutes = MINUTE_KEYS.map((k) => Object.entries(args).find(([key]) => snake(key) === k)?.[1]).find((v) => !empty(v));
  if (rawHours === undefined && rawMinutes === undefined) return undefined;
  const hours = rawHours === undefined ? 0 : count(rawHours);
  const minutes = rawMinutes === undefined ? 0 : count(rawMinutes);
  if (hours === null || minutes === null || hours + minutes === 0) return null;
  const parts = [hours ? (hours === 1 ? "1 hour" : `${hours} hours`) : "", minutes ? (minutes === 1 ? "1 minute" : `${minutes} minutes`) : ""].filter(Boolean);
  return parts.join(" and ");
}

/** The event's when, said whole: its start, its zone, and its end or how long it runs. Null when any part can't be said. */
function spokenSpan(args: Record<string, unknown>): string | null {
  const start = field(args, START_KEYS);
  const when = spokenWhen(start);
  if (!when) return null;
  const zones = zonesOf(args);
  if (zones === null || zones.length > 1) return null;
  let zone = "";
  if (zones.length === 1) {
    const said = spokenZone(zones[0]);
    if (!said) return null;
    // A day-long event has no clock for a zone to change.
    zone = start!.includes(":") ? ` ${said}` : "";
  }
  const endRaw = Object.entries(args).find(([k, v]) => END_KEYS.includes(snake(k)) && !empty(v));
  const duration = spokenDuration(args);
  if (endRaw && duration !== undefined) return null;
  if (duration === null) return null;
  let until = "";
  if (endRaw) {
    const end = field(args, END_KEYS);
    const endWhen = spokenWhen(end);
    if (!endWhen) return null;
    const [startDay] = when.split(" at ");
    const [endDay, endClock] = endWhen.split(" at ");
    until = endDay === startDay && endClock ? `, until ${endClock}` : `, until ${endWhen}`;
  } else if (duration) {
    until = `, for ${duration}`;
  }
  return `${when}${zone}${until}`;
}

/** What the call says before a yes counts, built from the action's own arguments; null when it can't be said plainly. */
function readBackFor(shape: Shape, args: Record<string, unknown>, people: People): string | null {
  // A secret in anything it would quote: none of it is read out, so none of it is voice-ok.
  const quoted = [SUBJECT_KEYS, BODY_KEYS, TITLE_KEYS, ["text"]].map((keys) => field(args, keys));
  if (quoted.some((v) => v !== null && maskSecrets(v) !== v)) return null;
  const to = names(people.to);
  const subject = words(field(args, SUBJECT_KEYS), 120);
  const about = subject ? `, subject “${subject}”` : "";
  const build = (body: (room: number) => string, lead: string): string | null => {
    const room = MAX_READ_BACK - lead.length - 2;
    if (room < 0) return null;
    return `${lead}${body(room)}.`;
  };
  // The body's first sentence, quoted, in what room the rest leaves (none when that's too little to say anything).
  const saying = (verb: string) => (room: number) => {
    const max = Math.min(MAX_EXCERPT, room - verb.length - 6);
    const quote = max >= 20 ? excerpt(args, max) : null;
    return quote ? `, ${verb} “${quote}”` : "";
  };
  let line: string | null;
  switch (shape) {
    case "email":
      line = build(saying("saying"), `I'll email ${to}${copies(people)}${about}${attachments(args)}`);
      break;
    case "reply":
      line = build(saying("saying"), `I'll reply in the thread to ${to}${copies(people)}${attachments(args)}`);
      break;
    case "forward":
      line = build(saying("adding"), `I'll forward the email to ${to}${copies(people)}${attachments(args)}`);
      break;
    case "draft": {
      const lead = `I'll save a draft${to ? ` to ${to}` : ""}${copies(people)}${about}${attachments(args)}`;
      line = build((room) => `${saying("saying")(room - 18)}. It won't be sent`, lead);
      break;
    }
    case "event": {
      const title = words(field(args, TITLE_KEYS), 120);
      const when = spokenSpan(args);
      if (!when) return null;
      line = build(() => "", `I'll add ${title ? `“${title}”` : "an event"} to your calendar for ${when}${people.all.length ? `, inviting ${names(people.all)}` : ""}`);
      break;
    }
    case "quick_event": {
      const text = words(field(args, ["text"]), 200);
      line = text ? `I'll add this to your calendar: “${text}”.` : null;
      break;
    }
  }
  if (!line || line.length > MAX_READ_BACK || TECHNICAL.test(line) || line.includes("•")) return null;
  return line;
}

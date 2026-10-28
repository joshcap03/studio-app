import type { ApprovalAction } from "@/lib/agent/types";
import { appForToolkit, appName } from "@/lib/apps";

// Whether a request the agent paused on is of a kind the member OKs once for good, so later runs
// of any of their agents don't ask again (a standing approval). The agent asks only before it
// moves money or deletes for good (tool_gateway.py `needs_approval`), and each use case asks once:
// the first approval of a kind OKs it. A kind is one app tool (`tool:STRIPE_CREATE_REFUND`), or
// paying on one website in the agent's browser (`site:usps.com`, the host read from the browser
// itself, never from the agent's words), or the older `gmail_labels`. Decided once, when the
// agent asks, from what approving it would run (the adapter's `actions`), never from the agent's
// own summary. Fails closed: code, and a request mixing kinds, ask every time. Pure, and free of
// server code: its labels show on the card, the task's page, and Settings.

/** The older fixed kinds; any other kind is one app tool or one website. */
export const STANDING_KINDS = ["gmail_labels"] as const;
export type StandingKind = (typeof STANDING_KINDS)[number] | `tool:${string}` | `site:${string}`;

const TOOL_KIND = /^tool:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const SITE_KIND = /^site:(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const SLUG = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

export function isStandingKind(value: unknown): value is StandingKind {
  return (
    typeof value === "string" &&
    value.length <= 260 &&
    ((STANDING_KINDS as readonly string[]).includes(value) || TOOL_KIND.test(value) || SITE_KIND.test(value))
  );
}


/** How a kind reads on the card, the task's page, and Settings: what the member lets it do without asking. */
export function standingLabel(kind: StandingKind): string {
  if (kind === "gmail_labels") return "Sort your Gmail with labels";
  if (kind.startsWith("site:")) return `Pay and order on ${kind.slice(5)}`;
  const slug = kind.slice(5);
  return `${appName(appForToolkit(slug))}: ${slug.toLowerCase().split("_").slice(1).join(" ")}`;
}

/** What the agent is told once the member has OK'd a kind. */
export function standingGuide(kind: StandingKind): string {
  if (kind === "gmail_labels") {
    return "adding or removing labels on their Gmail, and creating labels, with GMAIL_BATCH_MODIFY_MESSAGES, GMAIL_ADD_LABEL_TO_EMAIL, GMAIL_MODIFY_THREAD_LABELS, or GMAIL_CREATE_LABEL called directly through take_action (never in code, which always asks). Trash, Spam, Inbox (archiving), Sent, and Drafts are never covered";
  }
  if (kind.startsWith("site:")) return `paying and placing orders on ${kind.slice(5)} in your browser, each such step through take_action`;
  return `${kind.slice(5)} called directly through take_action (not in code, which asks)`;
}

/** The host a kind is keyed by, from the browser page's origin: lowercased, without www. */
export function siteOf(origin: string | null | undefined): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return SITE_KIND.test(`site:${host}`) ? host : null;
  } catch {
    return null;
  }
}

// Gmail's own labels that would trash, mark spam, archive (taking INBOX off), or pass for sent mail
// or a draft. Any other label (the member's own, CATEGORY_*, UNREAD, STARRED, IMPORTANT) is tidy.
const GMAIL_LOCKED_LABELS = new Set(["TRASH", "SPAM", "INBOX", "SENT", "DRAFT", "CHAT"]);
const LABEL_IDS = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_MESSAGES = 1000;

/** A list of label ids none of which is locked; absent is an empty list. */
function tidyLabels(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!Array.isArray(value) || value.length > 50) return false;
  return value.every((id) => typeof id === "string" && LABEL_IDS.test(id) && !GMAIL_LOCKED_LABELS.has(id.toUpperCase()));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const ownMailbox = (value: unknown) => value === undefined || value === null || value === "me";
const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const short = (value: unknown, max: number) => value === undefined || value === null || (typeof value === "string" && value.length <= max);

/** Only these keys, so an argument Studio doesn't know can't widen what runs. */
function onlyKeys(args: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(args).every((k) => keys.includes(k));
}

function gmailLabels(action: ApprovalAction): boolean {
  const args = action.arguments;
  if (!isRecord(args)) return false;
  switch (action.tool) {
    case "GMAIL_ADD_LABEL_TO_EMAIL":
      return (
        onlyKeys(args, ["user_id", "message_id", "add_label_ids", "remove_label_ids"]) &&
        ownMailbox(args.user_id) && id(args.message_id) && tidyLabels(args.add_label_ids) && tidyLabels(args.remove_label_ids)
      );
    case "GMAIL_MODIFY_THREAD_LABELS":
      return (
        onlyKeys(args, ["user_id", "thread_id", "add_label_ids", "remove_label_ids"]) &&
        ownMailbox(args.user_id) && id(args.thread_id) && tidyLabels(args.add_label_ids) && tidyLabels(args.remove_label_ids)
      );
    case "GMAIL_BATCH_MODIFY_MESSAGES":
      return (
        onlyKeys(args, ["userId", "messageIds", "addLabelIds", "removeLabelIds"]) &&
        ownMailbox(args.userId) &&
        Array.isArray(args.messageIds) && args.messageIds.length > 0 && args.messageIds.length <= MAX_MESSAGES && args.messageIds.every(id) &&
        tidyLabels(args.addLabelIds) && tidyLabels(args.removeLabelIds)
      );
    case "GMAIL_CREATE_LABEL": {
      const name = args.label_name ?? args.name;
      return (
        onlyKeys(args, ["user_id", "label_name", "name", "text_color", "background_color", "label_list_visibility", "message_list_visibility"]) &&
        ownMailbox(args.user_id) &&
        typeof name === "string" && name.trim().length > 0 && name.length <= 100 && !GMAIL_LOCKED_LABELS.has(name.trim().toUpperCase()) &&
        short(args.text_color, 20) && short(args.background_color, 20) && short(args.label_list_visibility, 40) && short(args.message_list_visibility, 40)
      );
    }
    default:
      return false;
  }
}

/** Tools in the agent's browser that act on a page. */
const BROWSER_STEPS = new Set(["act"]);

/**
 * The kind of standing OK that would cover every action in this request, or null when none
 * would. `site` is the host of the page the agent's browser is on (siteOf), for a browser step;
 * `tidyOnly` (a run an event started, which reads other people's words) considers only the older
 * tidy kinds, never one that moves money.
 */
export function standingKindFor(
  actions: ApprovalAction[] | undefined,
  { site, tidyOnly = false }: { site?: string | null; tidyOnly?: boolean } = {},
): StandingKind | null {
  if (!actions?.length) return null;
  if (actions.every(gmailLabels)) return "gmail_labels";
  if (tidyOnly) return null;
  if (actions.every((a) => BROWSER_STEPS.has(a.tool))) return site && isStandingKind(`site:${site}`) ? `site:${site}` : null;
  const slugs = new Set(actions.map((a) => a.tool));
  const [slug] = slugs;
  if (slugs.size !== 1 || !SLUG.test(slug) || slug.startsWith("COMPOSIO_")) return null;
  return `tool:${slug}`;
}

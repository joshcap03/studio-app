import type { ApprovalAction } from "@/lib/agent/types";

// Whether a request the agent paused on is of a kind a member may OK once for a task, so that
// task's later runs don't ask again (a standing approval). Decided once, when the agent asks,
// from what approving it would run (the adapter's `actions`, with their raw arguments), never
// from the agent's own summary. Fails closed: a kind qualifies only when every action in the
// request is one Studio can check from its arguments to be tidy, undoable, and reaching no one.
// Code, the browser, and anything that sends, deletes, archives, trashes, or moves money never
// qualify. Pure, and free of server code: its labels show on the card and the task's page.

export const STANDING_KINDS = ["gmail_labels"] as const;
export type StandingKind = (typeof STANDING_KINDS)[number];

/** How each kind reads on the card and the task's page: what the member lets it do without asking. */
export const STANDING_LABELS: Record<StandingKind, string> = {
  gmail_labels: "Sort your Gmail with labels",
};

/** What the agent is told on a task's runs once the member has OK'd a kind there. */
export const STANDING_GUIDES: Record<StandingKind, string> = {
  gmail_labels:
    "adding or removing labels on their Gmail, and creating labels, with GMAIL_BATCH_MODIFY_MESSAGES, GMAIL_ADD_LABEL_TO_EMAIL, GMAIL_MODIFY_THREAD_LABELS, or GMAIL_CREATE_LABEL called directly through take_action (never in code, which always asks). Trash, Spam, Inbox (archiving), Sent, and Drafts are never covered",
};

export function isStandingKind(value: unknown): value is StandingKind {
  return typeof value === "string" && (STANDING_KINDS as readonly string[]).includes(value);
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

const CHECKS: Record<StandingKind, (action: ApprovalAction) => boolean> = { gmail_labels: gmailLabels };

/** The kind of standing OK that would cover every action in this request, or null when none would. */
export function standingKindFor(actions: ApprovalAction[] | undefined): StandingKind | null {
  if (!actions?.length) return null;
  return STANDING_KINDS.find((kind) => actions.every(CHECKS[kind])) ?? null;
}

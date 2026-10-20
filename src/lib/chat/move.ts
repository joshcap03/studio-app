import type { ChatMessage, MessageStatus, RunReport } from "@/lib/types";

// Whose move it is in a conversation, from real state only: the agent is working on it, it's the
// member's call (an approval, a card or a question waiting on them, or a task run that needs
// them), it's done, it's stuck (failed or cut off), or nothing's going on. One answer for every
// place that shows it: the reply's mark, the composer's hint, the call's orb, the journey rail,
// the sidebar, and the push. Plan steps marked needs_you or blocked don't count on their own:
// they're the agent's last report and go stale once the member answers.

export type Move = "working" | "your_call" | "done" | "stuck" | "idle";

/** What a reply still asks of the member. Anything else it carries (an offer to talk) asks nothing. */
export type Ask = "approval" | "form" | "proposal" | "merge" | "question";
export type MoveReason = Ask | "report" | "failed";

export interface WhoseMove {
  move: Move;
  reason?: MoveReason;
}

/** The latest message as far as whose move it is: who wrote it, how it stands, and what it asks. */
export interface LastMessage {
  role: ChatMessage["role"];
  status: MessageStatus;
  ask: Ask | null;
}

/** The moves worth a mark where the conversation isn't open: done needs none (there's no "unread"). */
export const MARKED_MOVES = ["working", "your_call", "stuck"] as const;
export type MarkedMove = (typeof MARKED_MOVES)[number];

export const MOVE_LABEL: Record<Exclude<Move, "idle">, string> = {
  working: "On it",
  your_call: "Your call",
  done: "Done",
  stuck: "Stuck",
};

/**
 * What a message still asks of the member, first: a pending approval, then the first card they
 * haven't answered or applied (a form, a proposed setup, a proposed merge), then its questions.
 */
export function askOf(message: Pick<ChatMessage, "approvals" | "ui" | "uiResponse" | "questions">): Ask | null {
  if (message.approvals?.some((a) => a.status === "pending")) return "approval";
  for (const block of message.ui ?? []) {
    if (message.uiResponse?.[block.id]) continue;
    if (block.kind === "form") return "form";
    if (block.kind === "proposal") return "proposal";
    if (block.kind === "memory-merge") return "merge";
  }
  return message.questions?.length ? "question" : null;
}

/** The latest message of a loaded thread, as moveFrom reads it. */
export function lastMessageOf(message: ChatMessage | undefined): LastMessage | undefined {
  return message ? { role: message.role, status: message.status, ask: askOf(message) } : undefined;
}

/**
 * Whose move it is, from the conversation's latest message. `running`: a run is going on here
 * right now (this tab is streaming it, or following it). `report`: how a task's run said it went,
 * when that's known (the turn that just ended). A "streaming" message is taken as live: callers
 * read it through the store, which counts one gone quiet as interrupted.
 */
export function moveFrom(last: LastMessage | undefined, { running = false, report = null }: { running?: boolean; report?: RunReport | null } = {}): WhoseMove {
  if (running) return { move: "working" };
  if (!last || last.role !== "assistant") return { move: "idle" };
  switch (last.status) {
    case "streaming":
      return { move: "working" };
    case "awaiting":
      // Paused for an approval that's since been settled elsewhere waits on nothing.
      return last.ask === "approval" ? { move: "your_call", reason: "approval" } : { move: "idle" };
    case "error":
    case "interrupted":
      return { move: "stuck", reason: "failed" };
    case "complete":
      if (last.ask && last.ask !== "approval") return { move: "your_call", reason: last.ask };
      if (report?.outcome === "needs_you") return { move: "your_call", reason: "report" };
      return { move: "done" };
    default:
      return { move: "idle" };
  }
}

/** Whose move it is in a loaded thread, from its latest message. */
export function moveOf(last: ChatMessage | undefined, options: { running?: boolean; report?: RunReport | null } = {}): WhoseMove {
  return moveFrom(lastMessageOf(last), options);
}

/** The mark a conversation gets where it isn't open, or null for none. */
export function markOf(move: WhoseMove): MarkedMove | null {
  return (MARKED_MOVES as readonly string[]).includes(move.move) ? (move.move as MarkedMove) : null;
}

/** The marks for conversations that aren't open, from their latest messages; those without one are left out. */
export function marksOf(lasts: Record<string, LastMessage>): Record<string, MarkedMove> {
  const marks: Record<string, MarkedMove> = {};
  for (const [id, last] of Object.entries(lasts)) {
    const mark = markOf(moveFrom(last));
    if (mark) marks[id] = mark;
  }
  return marks;
}

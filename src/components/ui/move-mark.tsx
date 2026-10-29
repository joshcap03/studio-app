import { MOVE_LABEL, type MarkedMove } from "@/lib/chat/move";

/**
 * Whose move it is in a chat (or a project's chats) at a glance: the agent working on it, the
 * member's call (held still), or stuck. Nothing for done: there's no "unread" to show.
 */
export function MoveMark({ move }: { move?: MarkedMove }) {
  if (!move) return null;
  if (move === "working") return <span className="spinner shrink-0" aria-label="Working" />;
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      <span className={`size-1.5 rounded-full ${move === "stuck" ? "bg-danger" : "bg-accent"}`} aria-hidden="true" />
      <span className="sr-only">{MOVE_LABEL[move]}</span>
    </span>
  );
}

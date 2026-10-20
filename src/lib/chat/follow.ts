import type { ChatMessage, ConversationSummary, StreamEvent } from "@/lib/types";

// A run this tab isn't streaming (a task's run, the background worker's, or one it let go of
// while hidden) is followed by loading the conversation again every little while. For whoever
// listens to runs as they stream (a call narrating the work), the difference between two loads
// is turned back into the events the stream would have sent: the reply starting, its steps, its
// text, and its end. Only what the server saved is reported; nothing is guessed. Pure.

/**
 * The events between `before` and `after`, two copies of one conversation. `announced`: replies
 * whose start was already reported (streamed here, or reported by an earlier load); one that
 * wasn't is reported from its start, with everything it has so far.
 */
export function followEvents(
  before: ChatMessage[],
  after: ChatMessage[],
  conversation: ConversationSummary,
  announced: ReadonlySet<string>,
): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const reply of after) {
    if (reply.role !== "assistant") continue;
    const prev = before.find((m) => m.id === reply.id);
    const wasGoing = prev?.status === "streaming";
    const going = reply.status === "streaming";
    // A reply that started (or ran and ended) since the last load, or one going that no one has reported.
    const fresh = !announced.has(reply.id) && (going || !prev || (!wasGoing && prev.status !== reply.status));
    if (!fresh && !going && !wasGoing) continue;
    const base = fresh ? null : prev;
    if (fresh) events.push({ type: "start", conversation, userMessage: null, assistantMessage: reply });
    for (const step of reply.activity) {
      const old = base?.activity.find((s) => s.id === step.id);
      if (!old || old.status !== step.status || old.label !== step.label || old.hidden !== step.hidden) events.push({ type: "activity", step });
    }
    const said = base?.content ?? "";
    if (reply.content !== said) {
      events.push(reply.content.startsWith(said) ? { type: "text", delta: reply.content.slice(said.length) } : { type: "text-replace", text: reply.content });
    }
    if (!going) events.push({ type: "end", message: reply, conversation });
  }
  return events;
}

/**
 * A run a call followed into its conversation, from that conversation's first load here: its
 * latest reply's events from the start, as if it streamed here, even when it's already over (a
 * run that failed at once, or reached an approval first). Older replies there aren't news.
 */
export function joinedEvents(messages: ChatMessage[], conversation: ConversationSummary, announced: ReadonlySet<string>): StreamEvent[] {
  const run = messages.findLast((m) => m.role === "assistant");
  if (!run) return [];
  return followEvents(messages.filter((m) => m !== run), messages, conversation, announced);
}

import { moveOf } from "@/lib/chat/move";
import type { ChatMessage, Journey } from "@/lib/types";

/** The plan still says it's on a step, with nothing it reported as stopping there. */
const stillClaimsWork = (journey: Journey) =>
  journey.steps.some((s) => s.status === "doing" || s.status === "todo") && !journey.steps.some((s) => s.status === "blocked" || s.status === "needs_you");

/**
 * The journey to show over a thread: the plan of the work in it while it's the work in front of
 * the member. Once they've written since it last changed, a conversation's own finished plan is
 * done with, and any other goes when the reply leaves it as it was (it no longer says what's
 * happening, however its steps read); while that reply runs it may carry the plan on, and a plan
 * it changes shows again. A conversation's own plan also goes when the agent ended its reply
 * without finishing the plan and without handing the job on or asking anything: the rail would
 * say a step is under way when nothing is. No step is marked done for it, since only the agent
 * reports those. The setup interview's is shown from the setup's own summary instead.
 */
export function shownJourney(
  thread: { status: string; messages: ChatMessage[]; journey?: Journey | null } | undefined,
  running: boolean,
): Journey | null {
  const journey = thread?.status === "ready" ? (thread.journey ?? null) : null;
  if (!journey || journey.kind === "setup") return null;
  if (!thread!.messages.some((m) => m.role === "user" && m.createdAt > journey.updatedAt)) {
    const last = thread!.messages.at(-1);
    // A question in plain words waits on the member as much as a card does.
    const ended = moveOf(last, { running }).move === "done" && !last?.keepGoing && !last?.content.trim().endsWith("?");
    return journey.kind === "conversation" && ended && stillClaimsWork(journey) ? null : journey;
  }
  const finished = journey.steps.every((s) => s.status === "done");
  return running && !(journey.kind === "conversation" && finished) ? journey : null;
}

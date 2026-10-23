// What the member says on a call while they show the agent a job ("Show me once") goes into what
// they're showing as a note, not to the agent as a request: the agent is waiting for them to
// finish, and "now I pick the cheapest" is narration. The card listens while it's recording, for
// its conversation only; the call hands over their words (src/components/voice/call.tsx).

type Listener = (words: string) => void;

const listeners = new Map<string, Listener>();

/** Takes the member's words said on a call in this conversation until the returned stop is called. */
export function listenForNotes(conversationId: string, listener: Listener): () => void {
  listeners.set(conversationId, listener);
  return () => {
    if (listeners.get(conversationId) === listener) listeners.delete(conversationId);
  };
}

/** Whether a card is recording in this conversation. */
export function noting(conversationId: string): boolean {
  return listeners.has(conversationId);
}

/** Hands their words to the card recording in this conversation; false when none is. */
export function noteSaid(conversationId: string, words: string): boolean {
  const listener = listeners.get(conversationId);
  if (!listener || !words.trim()) return false;
  listener(words.trim());
  return true;
}

"use client";

import { useSyncExternalStore } from "react";
import { HOLD_MS } from "@/lib/voice/approval-guard";

// A call docked over the app shows a request waiting on the member's OK in the thread itself, not
// on its own stage. The thread's card needs what the call knows about it: whether it can be
// approved by voice, whether its spoken approval came back undecided, and the hold before it
// goes. The call publishes that here; a tap on the card stops any hold, as on the stage.

export interface CallApprovals {
  conversationId: string;
  spoken: boolean;
  spent: readonly string[];
  approving: { id: string; until: number } | null;
  now: number;
  /** Stops the hold: a tap answered it, or Cancel. */
  cancel: () => void;
}

let current: CallApprovals | null = null;
const listeners = new Set<() => void>();

export function publishCallApprovals(next: CallApprovals | null) {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * What the thread's ApprovalCard shows for `approvalId` in `conversationId` while a call is in
 * it: its `call` prop, and what a tap does first. Undefined when no call is there.
 */
export function useCallApproval(conversationId: string, approvalId: string) {
  const view = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  if (!view || view.conversationId !== conversationId) return undefined;
  const holding = view.approving?.id === approvalId ? view.approving : null;
  return {
    call: {
      spoken: view.spoken,
      spent: view.spent.includes(approvalId),
      hold: holding
        ? { left: Math.max(0, Math.min(1, (holding.until - view.now) / HOLD_MS)), waiting: view.now >= holding.until, onCancel: view.cancel }
        : null,
    },
    onTap: view.cancel,
  };
}

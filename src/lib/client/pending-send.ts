import type { RouteResult } from "@/lib/types";

// An ask typed on Home that goes to another agent than the tab's: the page loads under that agent
// (its own new-chat screen, /new) and sends it there as if it had been typed there. The ask waits
// in sessionStorage across that one load, for that one agent, and not for long. Pure, so it can be
// tested; storage failures (a private window) just mean nothing was stashed.

export interface PendingSend {
  v: 1;
  /** The agent it was routed to; the page that picks it up must be that agent's. */
  workspaceId: string;
  /** The conversation the client already made an id for. */
  conversationId: string;
  text: string;
  /** How Home decided, for the "Sent to …" line. */
  routed: { sure: boolean; by: RouteResult["by"] };
  at: number;
}

export const PENDING_SEND_KEY = "lj.pending-send";
export const PENDING_SEND_TTL_MS = 120_000;

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** Puts an ask aside for the agent's page to send. Returns whether it could be kept. */
export function stashPendingSend(send: Omit<PendingSend, "v" | "at">, store: Storage | null = storage(), now = Date.now()): boolean {
  if (!store) return false;
  try {
    store.setItem(PENDING_SEND_KEY, JSON.stringify({ ...send, v: 1, at: now } satisfies PendingSend));
    return true;
  } catch {
    return false;
  }
}

/**
 * Takes (and clears) the ask put aside: the send when it was for this agent; `{ mismatch }` with it
 * when it was for another (the page landed somewhere else, so its text goes back to the member and
 * nothing is sent); null when there's none or it's too old.
 */
export function takePendingSend(workspaceId: string, store: Storage | null = storage(), now = Date.now()): PendingSend | { mismatch: PendingSend } | null {
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(PENDING_SEND_KEY);
    if (raw !== null) store.removeItem(PENDING_SEND_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  const send = parse(raw);
  if (!send || now - send.at > PENDING_SEND_TTL_MS) return null;
  return send.workspaceId === workspaceId ? send : { mismatch: send };
}

function parse(raw: string): PendingSend | null {
  try {
    const value = JSON.parse(raw) as Partial<PendingSend> | null;
    if (!value || value.v !== 1 || typeof value.workspaceId !== "string" || typeof value.conversationId !== "string" || typeof value.text !== "string" || typeof value.at !== "number") return null;
    const by = value.routed?.by;
    return {
      v: 1,
      workspaceId: value.workspaceId,
      conversationId: value.conversationId,
      text: value.text,
      routed: { sure: value.routed?.sure === true, by: by === "model" || by === "heuristic" ? by : "last" },
      at: value.at,
    };
  } catch {
    return null;
  }
}

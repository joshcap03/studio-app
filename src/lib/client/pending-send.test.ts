import { describe, expect, it } from "vitest";
import { PENDING_SEND_KEY, PENDING_SEND_TTL_MS, stashPendingSend, takePendingSend } from "./pending-send";

// An ask from Home handed to another agent's page: kept for that agent only, briefly, once.

function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

const send = { workspaceId: "ws-b", conversationId: "c-1", text: "Draft the invoice", routed: { sure: true, by: "model" as const } };

describe("pending send", () => {
  it("comes back once, for the agent it was routed to", () => {
    const store = memory();
    expect(stashPendingSend(send, store, 1000)).toBe(true);
    expect(takePendingSend("ws-b", store, 2000)).toMatchObject({ ...send, v: 1, at: 1000 });
    expect(store.map.has(PENDING_SEND_KEY)).toBe(false);
    expect(takePendingSend("ws-b", store, 2000)).toBeNull();
  });

  it("is a mismatch for another agent's page, with the text to give back, and is cleared", () => {
    const store = memory();
    stashPendingSend(send, store, 1000);
    expect(takePendingSend("ws-a", store, 2000)).toEqual({ mismatch: { ...send, v: 1, at: 1000 } });
    expect(store.map.has(PENDING_SEND_KEY)).toBe(false);
  });

  it("expires", () => {
    const store = memory();
    stashPendingSend(send, store, 1000);
    expect(takePendingSend("ws-b", store, 1000 + PENDING_SEND_TTL_MS + 1)).toBeNull();
  });

  it("ignores what it can't read, and does without storage", () => {
    const store = memory();
    store.setItem(PENDING_SEND_KEY, "{not json");
    expect(takePendingSend("ws-b", store)).toBeNull();
    store.setItem(PENDING_SEND_KEY, JSON.stringify({ v: 2, workspaceId: "ws-b" }));
    expect(takePendingSend("ws-b", store)).toBeNull();
    expect(stashPendingSend(send, null)).toBe(false);
    expect(takePendingSend("ws-b", null)).toBeNull();
  });
});

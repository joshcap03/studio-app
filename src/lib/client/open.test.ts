import { describe, expect, it } from "vitest";
import { openRequest, reopening } from "./open";

const ORIGIN = "https://studio.test";
const C = "6f1c1d1e-0000-4000-8000-000000000001";
const M = "6f1c1d1e-0000-4000-8000-000000000002";

describe("a tapped notification, in a window that's already open", () => {
  it("goes to its conversation, pointing out the voice note it's about", () => {
    expect(openRequest({ type: "studio:open", url: `/c/${C}?play=${M}` }, ORIGIN)).toEqual({ kind: "conversation", conversationId: C, play: M });
    expect(openRequest({ type: "studio:open", url: `/c/${C}` }, ORIGIN)).toEqual({ kind: "conversation", conversationId: C, play: null });
    expect(openRequest({ type: "studio:open", url: `/c/${C}?play=not-an-id` }, ORIGIN)).toEqual({ kind: "conversation", conversationId: C, play: null });
  });

  it("goes to any other page of the app, and nowhere off it", () => {
    expect(openRequest({ type: "studio:open", url: "/tasks" }, ORIGIN)).toEqual({ kind: "page", path: "/tasks" });
    expect(openRequest({ type: "studio:open", url: "/c/not-an-id" }, ORIGIN)).toEqual({ kind: "page", path: "/c/not-an-id" });
    expect(openRequest({ type: "studio:open", url: "//elsewhere.test/c/x" }, ORIGIN)).toBeNull();
    expect(openRequest({ type: "studio:open", url: "https://elsewhere.test/" }, ORIGIN)).toBeNull();
    expect(openRequest({ type: "other", url: "/" }, ORIGIN)).toBeNull();
    expect(openRequest(null, ORIGIN)).toBeNull();
    expect(openRequest({ type: "studio:open" }, ORIGIN)).toBeNull();
  });
});

describe("opening a conversation that may have changed", () => {
  it("loads the one on screen again in place, rather than leaving the page waiting for a load that never comes", () => {
    // The member hid the tab mid-run (its stream let go) and tapped the push about the same conversation.
    expect(reopening(C, { onScreen: C, streaming: false })).toBe("refresh");
  });

  it("drops a copy that isn't on screen, so going there loads it, and keeps one this tab is streaming into", () => {
    expect(reopening(C, { onScreen: M, streaming: false })).toBe("drop");
    expect(reopening(C, { onScreen: null, streaming: false })).toBe("drop");
    expect(reopening(C, { onScreen: C, streaming: true })).toBe("keep");
    expect(reopening(C, { onScreen: null, streaming: true })).toBe("keep");
  });
});

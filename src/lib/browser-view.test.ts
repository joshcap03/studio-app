import { describe, expect, it } from "vitest";
import { openSession, screenshot, sealSession, type Socket } from "./browser-view";

const KEY = "bb_test_key";
const CONV = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";

describe("the conversation's browser, sealed", () => {
  it("opens only for the conversation and member it was sealed for", () => {
    const sealed = sealSession(KEY, CONV, USER, SESSION);
    expect(openSession(KEY, CONV, USER, sealed)).toBe(SESSION);
    expect(openSession(KEY, "44444444-4444-4444-8444-444444444444", USER, sealed)).toBeNull();
    expect(openSession(KEY, CONV, "55555555-5555-4555-8555-555555555555", sealed)).toBeNull();
    expect(openSession("another_key", CONV, USER, sealed)).toBeNull();
  });
  it("refuses an id a member wrote themselves, or one that isn't a session id", () => {
    const other = "66666666-6666-4666-8666-666666666666";
    const forged = `${other}.${sealSession(KEY, CONV, USER, SESSION).split(".")[1]}`;
    expect(openSession(KEY, CONV, USER, forged)).toBeNull();
    expect(openSession(KEY, CONV, USER, other)).toBeNull();
    expect(openSession(KEY, CONV, USER, "not-a-session.abc")).toBeNull();
    expect(openSession(KEY, CONV, USER, null)).toBeNull();
  });
});

/** A browser over CDP that answers the screenshot's three commands, and records them. */
function fakeBrowser({ pages = 2, fail }: { pages?: number; fail?: string } = {}) {
  const sent: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  let closed = false;
  const listeners: Record<string, ((e: { data?: unknown }) => void)[]> = {};
  const emit = (type: string, data?: unknown) => listeners[type]?.forEach((l) => l({ data }));
  const socket: Socket = {
    addEventListener: (type, listener) => void (listeners[type] = [...(listeners[type] ?? []), listener]),
    close: () => void (closed = true),
    send: (raw) => {
      const m = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
      sent.push(m);
      const reply = (result: unknown) => queueMicrotask(() => emit("message", JSON.stringify({ id: m.id, result })));
      if (m.method === fail) return queueMicrotask(() => emit("message", JSON.stringify({ id: m.id, error: { message: "nope" } })));
      if (m.method === "Target.getTargets")
        reply({ targetInfos: [{ targetId: "dev", type: "page", url: "devtools://x" }, ...Array.from({ length: pages }, (_, i) => ({ targetId: `p${i}`, type: "page", url: `https://site.example/${i}` })), { targetId: "w", type: "service_worker" }] });
      else if (m.method === "Target.attachToTarget") reply({ sessionId: `s-${String(m.params.targetId)}` });
      else if (m.method === "Page.captureScreenshot") reply({ data: Buffer.from("jpeg-bytes").toString("base64") });
    },
  };
  return { connect: () => (queueMicrotask(() => emit("open")), socket), sent, closed: () => closed };
}

describe("a screenshot over CDP", () => {
  it("pictures the last page open, with read-only commands, and disconnects", async () => {
    const browser = fakeBrowser();
    const jpeg = await screenshot("wss://connect.example", browser.connect);
    expect(Buffer.from(jpeg).toString()).toBe("jpeg-bytes");
    expect(browser.sent.map((m) => m.method)).toEqual(["Target.getTargets", "Target.attachToTarget", "Page.captureScreenshot"]);
    expect(browser.sent[1].params).toMatchObject({ targetId: "p1", flatten: true });
    expect(browser.sent[2].sessionId).toBe("s-p1");
    expect(browser.closed()).toBe(true);
  });
  it("fails, and disconnects, when there's no page or the browser refuses", async () => {
    const none = fakeBrowser({ pages: 0 });
    await expect(screenshot("wss://connect.example", none.connect)).rejects.toThrow("no page");
    expect(none.closed()).toBe(true);
    const refused = fakeBrowser({ fail: "Page.captureScreenshot" });
    await expect(screenshot("wss://connect.example", refused.connect)).rejects.toThrow("nope");
    expect(refused.closed()).toBe(true);
  });
  it("gives up after its time", async () => {
    const silent: Socket = { addEventListener: () => undefined, close: () => undefined, send: () => undefined };
    await expect(screenshot("wss://connect.example", () => silent, 20)).rejects.toThrow("timed out");
  });
});

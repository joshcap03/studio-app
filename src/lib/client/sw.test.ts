import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// public/sw.js, run as the browser runs it: a tapped notification opens its conversation in a
// Studio window that's already open, and a page that can't move there itself is sent there.

const ORIGIN = "https://studio.test";
const SOURCE = readFileSync(fileURLToPath(new URL("../../../public/sw.js", import.meta.url)), "utf8");
const C = "6f1c1d1e-0000-4000-8000-000000000001";
const M = "6f1c1d1e-0000-4000-8000-000000000002";

interface OpenWindow {
  url: string;
  focus: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  postMessage: (message: unknown, ports: MessagePort[]) => void;
  heard: unknown[];
}

/** A window on `path`; `listens` when its page runs a build that answers studio:open. */
function openWindow(path: string, listens: boolean): OpenWindow {
  const heard: unknown[] = [];
  return {
    url: ORIGIN + path,
    focus: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
    heard,
    postMessage: (message, ports) => {
      if (!listens) return;
      heard.push(message);
      ports[0].postMessage("opened");
    },
  };
}

function worker(windows: OpenWindow[]) {
  const listeners = new Map<string, (event: unknown) => void>();
  const opened: string[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => undefined,
    registration: { showNotification: async () => undefined },
    clients: {
      claim: async () => undefined,
      matchAll: async () => windows,
      openWindow: async (url: string) => void opened.push(url),
    },
  };
  runInNewContext(SOURCE, { self, MessageChannel, setTimeout, clearTimeout, URL });
  return {
    opened,
    /** Taps a notification about `url`; resolves once the worker is done with it. */
    tap(url: string): Promise<unknown> {
      let done: Promise<unknown> = Promise.resolve();
      listeners.get("notificationclick")!({ notification: { close: () => undefined, data: { url } }, waitUntil: (p: Promise<unknown>) => (done = p) });
      return done;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a tapped notification", () => {
  it("asks a chat page to move to the conversation itself, without a reload", async () => {
    const open = openWindow("/c/other", true);
    const sw = worker([open]);
    await sw.tap(`/c/${C}?play=${M}`);
    expect(open.focus).toHaveBeenCalled();
    expect(open.heard).toEqual([{ type: "studio:open", url: `/c/${C}?play=${M}` }]);
    expect(open.navigate).not.toHaveBeenCalled();
    expect(sw.opened).toEqual([]);
  });

  it("sends a chat page there when it doesn't say it heard (a page from before this worker)", async () => {
    const old = openWindow("/c/other", false);
    const sw = worker([old]);
    const done = sw.tap(`/c/${C}?play=${M}`);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(old.navigate).toHaveBeenCalledWith(`${ORIGIN}/c/${C}?play=${M}`);
  });

  it("sends any other page there, and opens a window when there's none", async () => {
    const settings = openWindow("/settings", true);
    await worker([settings]).tap(`/c/${C}`);
    expect(settings.heard).toEqual([]);
    expect(settings.navigate).toHaveBeenCalledWith(`${ORIGIN}/c/${C}`);
    const none = worker([]);
    await none.tap(`/c/${C}`);
    expect(none.opened).toEqual([`${ORIGIN}/c/${C}`]);
  });

  it("never leaves the app", async () => {
    const open = openWindow("/", true);
    await worker([open]).tap("https://elsewhere.test/c/x");
    expect(open.heard).toEqual([{ type: "studio:open", url: "/" }]);
  });
});

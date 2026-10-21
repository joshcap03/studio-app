import { describe, expect, it } from "vitest";
import { drivePage, fillPage } from "./browser-fill";
import type { Socket } from "./browser-view";

const PASSWORD = "hunter2-correct-horse";
const CARD = "4242424242424242";

interface Frame {
  /** The roles this document has a field for, and what the field is. */
  fields: Record<string, "input" | "select">;
  origin?: string;
}

/**
 * A browser over CDP with one page (and maybe frames): it answers which field a role finds,
 * takes typing into the focused field, and records every command, so a test can check that
 * values went only into Input.insertText.
 */
function fakeBrowser({ origin = "https://shop.example", page = { fields: {} } as Frame, frames = [] as Frame[] } = {}) {
  const sent: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  const docs: Record<string, Frame & { focused?: string; typed: Record<string, string> }> = {
    "s-page": { ...page, typed: {} },
    ...Object.fromEntries(frames.map((f, i) => [`s-frame${i}`, { ...f, typed: {} }])),
  };
  const listeners: Record<string, ((e: { data?: unknown }) => void)[]> = {};
  const emit = (type: string, data?: unknown) => listeners[type]?.forEach((l) => l({ data }));
  const socket: Socket = {
    addEventListener: (type, listener) => void (listeners[type] = [...(listeners[type] ?? []), listener]),
    close: () => undefined,
    send: (raw) => {
      const m = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
      sent.push(m);
      const reply = (result: unknown) => queueMicrotask(() => emit("message", JSON.stringify({ id: m.id, result })));
      const doc = m.sessionId ? docs[m.sessionId] : undefined;
      if (m.method === "Target.getTargets")
        return reply({ targetInfos: [{ targetId: "page", type: "page", url: `${origin}/` }, ...frames.map((_, i) => ({ targetId: `frame${i}`, type: "iframe" }))] });
      if (m.method === "Target.attachToTarget") return reply({ sessionId: `s-${String(m.params.targetId)}` });
      if (m.method === "Input.insertText") {
        if (doc?.focused) doc.typed[doc.focused] = String(m.params.text);
        return reply({});
      }
      if (m.method === "Runtime.evaluate") {
        const expression = String(m.params.expression);
        if (expression === "location.origin") return reply({ result: { value: origin } });
        const role = /const role = "([a-z_]+)"/.exec(expression)?.[1];
        if (role && doc) {
          const kind = doc.fields[role];
          doc.focused = kind ? role : undefined;
          return reply({ result: { value: kind ?? "none" } });
        }
        if (expression.includes("String(el.value).length")) return reply({ result: { value: doc?.focused ? (doc.typed[doc.focused]?.length ?? 0) : -1 } });
        if (expression.includes("selectedIndex") && doc?.focused) {
          doc.typed[doc.focused] = "picked";
          return reply({ result: { value: true } });
        }
        if (expression === "[innerWidth, innerHeight]") return reply({ result: { value: [1000, 500] } });
        return reply({ result: {} });
      }
      return reply({});
    },
  };
  return { connect: () => (queueMicrotask(() => emit("open")), socket), sent, docs };
}

describe("filling a login", () => {
  it("types the username then the password into the page, and only through Input.insertText", async () => {
    const browser = fakeBrowser({ origin: "https://acme.example", page: { fields: { username: "input", password: "input" } } });
    const result = await fillPage("wss://x", browser.connect, { username: "ada@example.test", password: PASSWORD }, { origin: "https://acme.example" });
    expect(result).toEqual({ ok: true, site: "https://acme.example", fields: ["username", "password"] });
    expect(browser.docs["s-page"].typed).toEqual({ username: "ada@example.test", password: PASSWORD });
    const typed = browser.sent.filter((m) => m.method === "Input.insertText").map((m) => m.params.text);
    expect(typed).toEqual(["ada@example.test", PASSWORD]);
    // The password is never in a script the page runs.
    expect(browser.sent.filter((m) => m.method !== "Input.insertText").some((m) => JSON.stringify(m).includes(PASSWORD))).toBe(false);
  });

  it("refuses a saved login on any other site, or on a page that isn't https", async () => {
    const lookalike = fakeBrowser({ origin: "https://acme.example.evil.test", page: { fields: { password: "input" } } });
    expect(await fillPage("wss://x", lookalike.connect, { password: PASSWORD }, { origin: "https://acme.example" })).toEqual({
      ok: false,
      reason: "wrong_site",
      site: "https://acme.example.evil.test",
    });
    expect(lookalike.sent.some((m) => m.method === "Input.insertText")).toBe(false);
    const plain = fakeBrowser({ origin: "http://acme.example", page: { fields: { password: "input" } } });
    expect(await fillPage("wss://x", plain.connect, { password: PASSWORD })).toMatchObject({ ok: false, reason: "not_https" });
    expect(plain.sent.some((m) => m.method === "Input.insertText")).toBe(false);
  });

  it("says so when the page has nowhere to put it", async () => {
    const browser = fakeBrowser({ page: { fields: {} } });
    expect(await fillPage("wss://x", browser.connect, { password: PASSWORD })).toEqual({ ok: false, reason: "no_fields", site: "https://shop.example" });
  });
});

describe("filling a card", () => {
  it("finds card fields in a checkout's payment frame, and masks the number and code", async () => {
    const browser = fakeBrowser({
      page: { fields: { card_name: "input" } },
      frames: [{ fields: { card_number: "input", card_expiry: "input", card_code: "input" } }],
    });
    const result = await fillPage("wss://x", browser.connect, { card_name: "Ada Lovelace", card_number: CARD, card_expiry: "04/27", card_code: "123" });
    expect(result).toEqual({ ok: true, site: "https://shop.example", fields: ["card_name", "card_number", "card_expiry", "card_code"] });
    expect(browser.docs["s-frame0"].typed).toEqual({ card_number: CARD, card_expiry: "04/27", card_code: "123" });
    expect(browser.sent.filter((m) => m.method !== "Input.insertText").some((m) => JSON.stringify(m).includes(CARD))).toBe(false);
    const focus = browser.sent.find((m) => m.method === "Runtime.evaluate" && String(m.params.expression).includes('const role = "card_number"'));
    expect(String(focus?.params.expression)).toContain("-webkit-text-security");
  });

  it("picks the expiry from month and year menus when there's no single field", async () => {
    const browser = fakeBrowser({ page: { fields: { card_number: "input", card_exp_month: "select", card_exp_year: "select" } } });
    const result = await fillPage("wss://x", browser.connect, { card_number: CARD, card_expiry: "04/27" });
    expect(result).toMatchObject({ ok: true, fields: ["card_number", "card_expiry"] });
    expect(browser.docs["s-page"].typed).toMatchObject({ card_exp_month: "picked", card_exp_year: "picked" });
  });
});

describe("taking the browser over", () => {
  it("clicks where the member clicked on the picture", async () => {
    const browser = fakeBrowser();
    await drivePage("wss://x", browser.connect, { type: "click", x: 0.5, y: 0.25 });
    const mouse = browser.sent.filter((m) => m.method === "Input.dispatchMouseEvent").map((m) => [m.params.type, m.params.x, m.params.y]);
    expect(mouse).toEqual([
      ["mouseMoved", 500, 125],
      ["mousePressed", 500, 125],
      ["mouseReleased", 500, 125],
    ]);
  });
  it("types and presses keys on the page", async () => {
    const browser = fakeBrowser();
    await drivePage("wss://x", browser.connect, { type: "text", text: "123456" });
    await drivePage("wss://x", browser.connect, { type: "key", key: "Enter" });
    expect(browser.sent.find((m) => m.method === "Input.insertText")?.params.text).toBe("123456");
    expect(browser.sent.filter((m) => m.method === "Input.dispatchKeyEvent").map((m) => m.params.type)).toEqual(["rawKeyDown", "char", "keyUp"]);
  });
});

import { describe, expect, it } from "vitest";
import { drivePage, fillPage } from "./browser-fill";
import type { Socket } from "./browser-view";

const PASSWORD = "hunter2-correct-horse";
const CARD = "4242424242424242";

interface Frame {
  /** The roles this document has a field for, and what the field is. */
  fields: Record<string, "input" | "select" | "split">;
  /** How many one-character boxes a split code has. */
  boxes?: number;
  origin?: string;
}

/**
 * A browser over CDP with one page (and maybe frames): it answers which field a role finds,
 * takes typing into the focused field, and records every command, so a test can check that
 * values went only into Input.insertText.
 */
function fakeBrowser({
  origin = "https://shop.example",
  page = { fields: {} } as Frame,
  frames = [] as Frame[],
  focusedField = { target: "field “Search”", sensitive: false } as { target: string; sensitive: unknown },
} = {}) {
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
        const box = /const box = (\d+)/.exec(expression)?.[1];
        if (box !== undefined && doc) {
          const ok = Number(box) < (doc.boxes ?? 0);
          doc.focused = ok ? `box${box}` : undefined;
          return reply({ result: { value: ok } });
        }
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
        // What a showing asks the page: the element at a point, or the field with focus.
        const page = { title: "Shop", url: `${origin}/beans` };
        if (expression.includes("elementFromPoint")) return reply({ result: { value: { page, target: "button “Add to cart”" } } });
        if (expression.includes("document.activeElement;\n  while")) return reply({ result: { value: { page, target: focusedField.target, sensitive: focusedField.sensitive } } });
        if (expression.includes("return { page }")) return reply({ result: { value: { page } } });
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

describe("filling a one-time code", () => {
  it("types the code into the page's code field", async () => {
    const browser = fakeBrowser({ origin: "https://acme.example", page: { fields: { one_time_code: "input" } } });
    expect(await fillPage("wss://x", browser.connect, { one_time_code: "482913" })).toEqual({ ok: true, site: "https://acme.example", fields: ["one_time_code"] });
    expect(browser.docs["s-page"].typed).toEqual({ one_time_code: "482913" });
    expect(browser.sent.filter((m) => m.method !== "Input.insertText").some((m) => JSON.stringify(m).includes("482913"))).toBe(false);
  });

  it("types one character per box when the code is split into boxes", async () => {
    const browser = fakeBrowser({ origin: "https://acme.example", page: { fields: { one_time_code: "split" }, boxes: 6 } });
    expect(await fillPage("wss://x", browser.connect, { one_time_code: "482913" })).toMatchObject({ ok: true, fields: ["one_time_code"] });
    expect(browser.docs["s-page"].typed).toEqual({ box0: "4", box1: "8", box2: "2", box3: "9", box4: "1", box5: "3" });
  });

  it("says so when there are fewer boxes than characters", async () => {
    const browser = fakeBrowser({ page: { fields: { one_time_code: "split" }, boxes: 4 } });
    expect(await fillPage("wss://x", browser.connect, { one_time_code: "482913" })).toMatchObject({ ok: false, reason: "no_fields" });
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

describe("showing the agent a job", () => {
  it("says what each input was done to, by the names on the page", async () => {
    const browser = fakeBrowser();
    expect(await drivePage("wss://x", browser.connect, { type: "click", x: 0.5, y: 0.25 }, { record: true })).toMatchObject({
      action: "click",
      target: "button “Add to cart”",
      page: { title: "Shop", url: "https://shop.example/beans" },
    });
    // The point asked about is where the click lands.
    const asked = String(browser.sent.find((m) => String(m.params.expression ?? "").includes("elementFromPoint"))?.params.expression);
    expect(asked).toContain("elementFromPoint(500, 125)");
    // The page's script keeps its regex escapes (a lone \s in a template literal turns into "s").
    expect(asked).not.toMatch(/\/s\+\/g/);
    expect(asked.match(/\/\\s\+\/g/g)?.length).toBeGreaterThanOrEqual(2);
    expect(await drivePage("wss://x", browser.connect, { type: "text", text: "house blend" }, { record: true })).toMatchObject({ action: "type", target: "field “Search”", text: "house blend" });
    expect(await drivePage("wss://x", browser.connect, { type: "key", key: "Enter" }, { record: true })).toMatchObject({ action: "key", key: "Enter" });
    expect(await drivePage("wss://x", browser.connect, { type: "scroll", x: 0.5, y: 0.5, dy: 300 }, { record: true })).toMatchObject({ action: "scroll", dy: 300 });
    expect(await drivePage("wss://x", browser.connect, { type: "look" }, { record: true })).toMatchObject({ action: "look", page: { title: "Shop" } });
  });

  it("never keeps what goes into a password, card, or code field, or anything that looks like a number to hide", async () => {
    const secret = fakeBrowser({ focusedField: { target: "field “Password”", sensitive: true } });
    const typed = await drivePage("wss://x", secret.connect, { type: "text", text: PASSWORD }, { record: true });
    expect(typed).toEqual(expect.objectContaining({ action: "type", hidden: true }));
    expect(JSON.stringify(typed)).not.toContain(PASSWORD);
    // It still goes into the page.
    expect(secret.sent.find((m) => m.method === "Input.insertText")?.params.text).toBe(PASSWORD);
    // A page that doesn't answer counts as a field to hide.
    const silent = fakeBrowser({ focusedField: { target: "field “Notes”", sensitive: undefined } });
    expect(await drivePage("wss://x", silent.connect, { type: "text", text: "hello" }, { record: true })).toMatchObject({ hidden: true });
    const plain = fakeBrowser();
    expect(JSON.stringify(await drivePage("wss://x", plain.connect, { type: "text", text: CARD }, { record: true }))).not.toContain(CARD);
    expect(JSON.stringify(await drivePage("wss://x", plain.connect, { type: "text", text: "123-45-6789" }, { record: true }))).not.toContain("6789");
  });

  it("asks the page nothing when it isn't recording", async () => {
    const browser = fakeBrowser();
    expect(await drivePage("wss://x", browser.connect, { type: "click", x: 0.1, y: 0.1 })).toBeNull();
    expect(await drivePage("wss://x", browser.connect, { type: "text", text: "hi" })).toBeNull();
    expect(browser.sent.some((m) => /elementFromPoint|activeElement/.test(String(m.params.expression ?? "")))).toBe(false);
  });
});

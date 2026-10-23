import { describe, expect, it } from "vitest";
import type { ShownNote, ShownStep } from "@/lib/types";
import { foldSteps, shownLines, shownText } from "./show-me";

const shop = { title: "Beans – Example Roasters", url: "https://www.roasters.example/beans" };
const cart = { title: "Your cart", url: "https://www.roasters.example/cart" };
const step = (at: number, s: Omit<ShownStep, "at" | "page"> & { page?: ShownStep["page"] }): ShownStep => ({ at, page: shop, ...s });

describe("showing the agent a job", () => {
  it("retells it as a person would: one scroll, one bit of typing per field, one run of a key", () => {
    const folded = foldSteps([
      step(1, { action: "look" }),
      step(2, { action: "scroll", dy: 300 }),
      step(3, { action: "scroll", dy: 200 }),
      step(4, { action: "click", target: "field “Search”" }),
      step(5, { action: "type", target: "field “Search”", text: "house " }),
      step(6, { action: "type", target: "field “Search”", text: "blend" }),
      step(7, { action: "key", key: "Backspace" }),
      step(8, { action: "key", key: "Backspace" }),
      step(9, { action: "scroll", dy: -100 }),
    ]);
    expect(folded.map((s) => [s.action, s.text ?? s.key ?? s.dy ?? s.target])).toEqual([
      ["scroll", 300],
      ["click", "field “Search”"],
      ["type", "house blend"],
      ["key", "Backspace ×2"],
      ["scroll", -100],
    ]);
  });

  it("names the page when it changes, and puts their notes where they said them", () => {
    const steps = [
      step(1, { action: "look" }),
      step(2, { action: "click", target: "link “House blend, 5 lb”" }),
      step(4, { action: "click", target: "button “Add to cart”" }),
      step(6, { action: "click", target: "link “Checkout”", page: cart }),
    ];
    const notes: ShownNote[] = [{ at: 3, text: "Always the 5 lb bag, it's cheaper per pound", via: "call" }];
    expect(shownLines(steps, notes)).toEqual([
      { kind: "step", text: "Clicked link “House blend, 5 lb”", page: "“Beans – Example Roasters” (roasters.example/beans)" },
      { kind: "note", text: "Always the 5 lb bag, it's cheaper per pound" },
      { kind: "step", text: "Clicked button “Add to cart”" },
      { kind: "step", text: "Clicked link “Checkout”", page: "“Your cart” (roasters.example/cart)" },
    ]);
  });

  it("never carries what went into a hidden field", () => {
    const text = shownText({ reason: "Reorder the beans", site: "Roasters" }, [
      step(1, { action: "click", target: "field “Password”" }),
      step(2, { action: "type", target: "field “Password”", hidden: true }),
      step(3, { action: "type", target: "field “Password”", hidden: true }),
      step(4, { action: "key", key: "Enter", page: cart }),
    ], []);
    expect(text).toContain("2. Typed into field “Password” (hidden: not recorded)");
    expect(text).not.toContain("3. Typed");
    expect(text).toContain("It ended on “Your cart”");
    expect(text).toMatch(/^I've shown you how I do it on Roasters\./);
    expect(text).toMatch(/Write it up as a skill for me to check, with your guesses\.$/);
  });

  it("puts what they said before the first step first, and later notes under their step", () => {
    const text = shownText({ reason: "x" }, [step(2, { action: "click", target: "button “Search”" }), step(4, { action: "key", key: "Enter" })], [
      { at: 1, text: "First I search", via: "call" },
      { at: 3, text: "then Enter", via: "typed" },
    ]);
    expect(text).toContain("\n\nI said: “First I search”\n1. On “Beans – Example Roasters” (roasters.example/beans): Clicked button “Search”\n   I said: “then Enter”\n2. Pressed Enter\n");
  });

  it("says so when nothing was shown, keeping what they said", () => {
    expect(shownText({ reason: "x" }, [step(1, { action: "look" })], [{ at: 2, text: "Hm, it's asking me to sign in", via: "typed" }])).toBe(
      "I didn't get to show you in the browser.\n\nWhat I said:\n- “Hm, it's asking me to sign in”",
    );
  });
});

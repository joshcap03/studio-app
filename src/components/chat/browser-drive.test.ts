import { describe, expect, it } from "vitest";
import { keystroke } from "./browser-drive";

// Driving the agent's browser by keyboard: keys on the picture go to the page as they would on the
// page itself, and the box passes through what it has no use for.

const key = (k: string, mods: Partial<Parameters<typeof keystroke>[0]> = {}) => ({ key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...mods });

describe("keys on the picture", () => {
  it("presses Enter, Tab, Backspace, Escape, and the arrows on the page", () => {
    for (const k of ["Enter", "Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) expect(keystroke(key(k))).toEqual({ press: k });
  });

  it("types letters, spaces, and capitals there", () => {
    expect(keystroke(key("a"))).toEqual({ type: "a" });
    expect(keystroke(key(" "))).toEqual({ type: " " });
    expect(keystroke(key("A", { shiftKey: true }))).toEqual({ type: "A" });
  });

  it("leaves shortcuts, Shift+Tab, composing, and other keys alone", () => {
    expect(keystroke(key("v", { metaKey: true }))).toBeNull();
    expect(keystroke(key("c", { ctrlKey: true }))).toBeNull();
    expect(keystroke(key("Enter", { altKey: true }))).toBeNull();
    expect(keystroke(key("Tab", { shiftKey: true }))).toBeNull();
    expect(keystroke(key("a", { isComposing: true }))).toBeNull();
    expect(keystroke(key("Shift"))).toBeNull();
    expect(keystroke(key("F5"))).toBeNull();
  });
});

describe("keys in the box", () => {
  it("presses Enter and Tab on the page, with or without something typed", () => {
    expect(keystroke(key("Enter"), "hunter2")).toEqual({ press: "Enter" });
    expect(keystroke(key("Enter"), "")).toEqual({ press: "Enter" });
    expect(keystroke(key("Tab"), "me@example.test")).toEqual({ press: "Tab" });
  });

  it("keeps Backspace, Escape, and the arrows for the box while it has something in it", () => {
    expect(keystroke(key("Backspace"), "abc")).toBeNull();
    expect(keystroke(key("ArrowLeft"), "abc")).toBeNull();
    expect(keystroke(key("Backspace"), "")).toEqual({ press: "Backspace" });
    expect(keystroke(key("ArrowDown"), "")).toEqual({ press: "ArrowDown" });
  });

  it("leaves letters to the box", () => {
    expect(keystroke(key("a"), "")).toBeNull();
  });
});

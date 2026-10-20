import { describe, expect, it } from "vitest";
import { inlineEditHandlers } from "./inline-edit";

// A field edited in place saves on blur and Enter, and Escape cancels. The browser blurs the
// field inside the Escape keydown, before React re-renders, so the blur runs with this render's
// handlers, which still hold the edit; it must not save it.

/** One render of a field showing `text`, with the saved value `saved`. */
function field(cancelled: { current: boolean }, text: string, saved: string, log: { saves: string[]; shown: string }) {
  const handlers = inlineEditHandlers(cancelled, {
    commit: () => {
      if (text !== saved) log.saves.push(text);
    },
    revert: () => {
      log.shown = saved;
    },
  });
  // Blurring from a handler fires blur right away, as the browser does.
  const target = { blur: () => handlers.onBlur() };
  return { ...handlers, key: (key: string) => handlers.onKeyDown({ key, currentTarget: target }) };
}

describe("a field edited in place", () => {
  it("puts the saved text back on Escape, without saving the edit", () => {
    const cancelled = { current: false };
    const log = { saves: [] as string[], shown: "edited" };
    const render = field(cancelled, "edited", "original", log);
    render.onFocus();
    render.key("Escape");
    expect(log).toEqual({ saves: [], shown: "original" });
    // The next edit saves as usual.
    const next = field(cancelled, "edited again", "original", log);
    next.onFocus();
    next.onBlur();
    expect(log.saves).toEqual(["edited again"]);
  });

  it("saves on Enter and on leaving the field", () => {
    const cancelled = { current: false };
    const log = { saves: [] as string[], shown: "" };
    field(cancelled, "two interviews booked", "", log).key("Enter");
    field(cancelled, "three interviews booked", "two interviews booked", log).onBlur();
    expect(log.saves).toEqual(["two interviews booked", "three interviews booked"]);
  });

  it("forgets an Escape whose blur never came once the field is focused again", () => {
    const cancelled = { current: true };
    const log = { saves: [] as string[], shown: "" };
    const render = field(cancelled, "edited", "original", log);
    render.onFocus();
    render.onBlur();
    expect(log.saves).toEqual(["edited"]);
  });
});

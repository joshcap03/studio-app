import { describe, expect, it } from "vitest";
import { listenForNotes, noteSaid, noting } from "./show-me-notes";

describe("words said on a call while showing a job", () => {
  it("go to the card recording in that conversation only, until it stops", () => {
    const heard: string[] = [];
    const stop = listenForNotes("c1", (w) => heard.push(w));
    expect(noting("c1")).toBe(true);
    expect(noteSaid("c2", "send it")).toBe(false);
    expect(noteSaid("c1", "  always the nonstop one ")).toBe(true);
    expect(noteSaid("c1", "   ")).toBe(false);
    stop();
    expect(noteSaid("c1", "and then I pay")).toBe(false);
    expect(heard).toEqual(["always the nonstop one"]);
  });

  it("a card that stopped doesn't stop the one listening after it", () => {
    const first = listenForNotes("c3", () => undefined);
    const second: string[] = [];
    listenForNotes("c3", (w) => second.push(w));
    first();
    expect(noteSaid("c3", "this one")).toBe(true);
    expect(second).toEqual(["this one"]);
  });
});

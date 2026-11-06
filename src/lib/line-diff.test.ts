import { describe, expect, it } from "vitest";
import { foldDiff, lineDiff } from "./line-diff";

describe("lineDiff", () => {
  it("keeps what's common and marks what changed", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "gone", text: "b" },
      { kind: "new", text: "x" },
      { kind: "same", text: "c" },
    ]);
  });

  it("treats an empty side as no lines", () => {
    expect(lineDiff("", "a")).toEqual([{ kind: "new", text: "a" }]);
    expect(lineDiff("a", "")).toEqual([{ kind: "gone", text: "a" }]);
    expect(lineDiff("", "")).toEqual([]);
  });

  it("shows both sides whole when the texts are too long to compare", () => {
    const long = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const lines = lineDiff(long, `${long}\nmore`);
    expect(lines.filter((l) => l.kind === "gone")).toHaveLength(1000);
    expect(lines.filter((l) => l.kind === "new")).toHaveLength(1001);
  });
});

describe("foldDiff", () => {
  it("folds long unchanged runs, keeping lines around a change", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n");
    const folded = foldDiff(lineDiff(before, `${before}\n9`));
    expect(folded[0]).toEqual({ kind: "fold", count: 6 });
    expect(folded.at(-1)).toEqual({ kind: "new", text: "9" });
  });

  it("leaves short runs alone", () => {
    expect(foldDiff(lineDiff("a\nb", "a\nc")).some((l) => l.kind === "fold")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { describeScore, missed } from "./verdicts";

describe("missed", () => {
  const calls = (kept: number, passed: number) => [
    ...Array.from({ length: kept }, () => ({ verdict: "keep" as const })),
    ...Array.from({ length: passed }, () => ({ verdict: "pass" as const })),
  ];

  it("is a batch they passed on at least three quarters of, two results or more", () => {
    expect(missed(calls(0, 4))).toBe(true);
    expect(missed(calls(1, 3))).toBe(true);
    expect(missed(calls(0, 2))).toBe(true);
    expect(missed(calls(0, 3))).toBe(true);
    expect(missed(calls(2, 2))).toBe(false);
    expect(missed(calls(1, 2))).toBe(false);
    expect(missed(calls(1, 1))).toBe(false);
    expect(missed(calls(0, 1))).toBe(false);
    expect(missed([])).toBe(false);
  });
});

describe("describeScore", () => {
  it("says what the member kept, and nothing before they've judged anything", () => {
    expect(describeScore({ kept: 4, judged: 5, days: 7 })).toBe("4 of 5 kept this past week");
    expect(describeScore({ kept: 0, judged: 3, days: 30 })).toBe("0 of 3 kept in the last 30 days");
    expect(describeScore({ kept: 0, judged: 0, days: 7 })).toBeNull();
  });
});

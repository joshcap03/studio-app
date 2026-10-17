import { describe, expect, it } from "vitest";
import { describeScore } from "./verdicts";

describe("describeScore", () => {
  it("says what the member kept, and nothing before they've judged anything", () => {
    expect(describeScore({ kept: 4, judged: 5, days: 7 })).toBe("4 of 5 kept this past week");
    expect(describeScore({ kept: 0, judged: 3, days: 30 })).toBe("0 of 3 kept in the last 30 days");
    expect(describeScore({ kept: 0, judged: 0, days: 7 })).toBeNull();
  });
});

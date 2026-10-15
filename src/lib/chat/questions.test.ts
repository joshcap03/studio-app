import { describe, expect, it } from "vitest";
import { buildQuestions } from "./questions";

describe("buildQuestions", () => {
  it("accepts the gateway's shape and caps questions and options", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      question: `Q${i}?`,
      multi_select: i === 1,
      options: Array.from({ length: 6 }, (_, j) => ({ label: `O${j}` })),
    }));
    const built = buildQuestions({ questions: many });
    expect(built).toHaveLength(3);
    expect(built![0].options).toHaveLength(4);
    expect(built!.map((q) => q.multiSelect)).toEqual([false, true, false]);
  });

  it("takes plain-string options", () => {
    expect(buildQuestions([{ question: "Q?", options: ["Yes", "No"] }])).toEqual([{ question: "Q?", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false }]);
  });

  it("drops questions without text or two distinct options, and junk", () => {
    expect(buildQuestions([{ question: "", options: [{ label: "a" }, { label: "b" }] }])).toBeNull();
    expect(buildQuestions([{ question: "Q?", options: [{ label: "a" }, { label: " A " }] }])).toBeNull();
    expect(buildQuestions("not questions")).toBeNull();
    expect(buildQuestions([{ question: 4, options: [] }])).toBeNull();
  });
});

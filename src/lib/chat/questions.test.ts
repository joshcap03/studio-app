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

  it("keeps a long question whole up to the cap, then cuts at a word with an ellipsis", () => {
    const plan = "Here's the final plan: (1) you send an address; I check it. (2) I enter the box size and pick the cheapest ground. (3) She gets a card with the price and label preview, and nothing is bought until she approves it?";
    expect(buildQuestions([{ question: plan, options: ["Yes", "No"] }])![0].question).toBe(plan);
    const long = "word ".repeat(400);
    const q = buildQuestions([{ question: long, options: ["Yes", "No"] }])![0].question;
    expect(q.length).toBeLessThanOrEqual(1000);
    expect(q.endsWith("word…")).toBe(true);
  });
});

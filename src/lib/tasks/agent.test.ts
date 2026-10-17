import { describe, expect, it } from "vitest";
import { planFromAgent } from "./agent";

describe("planFromAgent", () => {
  it("turns the agent's steps into a stored plan, keeping ids of unchanged steps", () => {
    const previous = [{ id: "member-1", text: "Find roles", status: "todo" as const, note: null }];
    expect(
      planFromAgent(
        [
          { text: "Find roles", status: "done", note: "  12 found " },
          { text: "Tailor the top 3", status: "doing" },
          "Send outreach",
          { text: "  ", status: "todo" },
          { text: "Ask about salary", status: "nonsense" },
        ],
        previous,
      ),
    ).toEqual([
      { id: "member-1", text: "Find roles", status: "done", note: "12 found" },
      { id: "s2", text: "Tailor the top 3", status: "doing", note: null },
      { id: "s3", text: "Send outreach", status: "todo", note: null },
      { id: "s5", text: "Ask about salary", status: "todo", note: null },
    ]);
  });

  it("refuses anything that isn't a list of steps, and caps the plan's length", () => {
    expect(planFromAgent("do things")).toBeNull();
    expect(planFromAgent({ steps: [] })).toBeNull();
    expect(planFromAgent(Array.from({ length: 50 }, (_, i) => ({ text: `Step ${i}`, status: "todo" })))).toHaveLength(30);
  });
});

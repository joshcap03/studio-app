import { describe, expect, it } from "vitest";
import { summarize } from "./records";

describe("summarize", () => {
  it("gives each collection its row count, statuses (most common first), and last change", () => {
    const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T12:00:00Z`;
    const summary = summarize([
      { collection: "applications", status: "passed", updated_at: at(19) },
      { collection: "contacts", status: null, updated_at: at(18) },
      { collection: "applications", status: "kept", updated_at: at(17) },
      { collection: "applications", status: "passed", updated_at: at(16) },
      { collection: "applications", status: null, updated_at: at(15) },
    ]);
    expect(summary).toEqual([
      {
        collection: "applications",
        count: 4,
        statuses: [
          { status: "passed", count: 2 },
          { status: "kept", count: 1 },
        ],
        updatedAt: Date.parse(at(19)),
      },
      { collection: "contacts", count: 1, statuses: [], updatedAt: Date.parse(at(18)) },
    ]);
    expect(summarize([])).toEqual([]);
  });
});

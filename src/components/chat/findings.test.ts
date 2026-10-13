import { describe, expect, it } from "vitest";
import type { ActivityStep } from "@/lib/types";
import { findingFor, findingForArtifact } from "./findings";

const step = (overrides: Partial<ActivityStep>): ActivityStep => ({
  id: "s",
  label: "Checked Gmail",
  status: "done",
  startedAt: 0,
  ...overrides,
});

describe("findings", () => {
  it("summarizes what was found, not what was done", () => {
    expect(
      findingFor(step({ app: "gmail", action: "read", preview: { type: "items", items: [{ primary: "Invoice #12" }, { primary: "Re: order" }], total: 12 } }))?.text,
    ).toBe("Found 12 emails · latest “Invoice #12”");
    expect(
      findingFor(
        step({
          app: "web",
          preview: {
            type: "sources",
            items: [
              { title: "A", url: "https://a.example/", domain: "a.example" },
              { title: "B", url: "https://b.example/", domain: "b.example" },
            ],
          },
        }),
      )?.text,
    ).toBe("Read 2 sources: a.example, b.example");
    expect(findingFor(step({ app: "memory", label: "Checked what I know about your business", preview: { type: "text", text: "Fiscal year starts in February" } }))?.text).toBe(
      "Remembered: Fiscal year starts in February",
    );
    expect(findingFor(step({ app: "sheets", action: "write", preview: { type: "table", columns: ["a"], rows: [["1"]], total: 95, title: "Inventory" } }))?.text).toBe(
      "Wrote 95 rows to “Inventory”",
    );
    expect(findingFor(step({ app: "code", preview: { type: "code", language: "python", code: "x", steps: ["Fetched 95 products", "Wrote 95 rows"] } }))?.text).toBe("Wrote 95 rows");
  });

  it("reports problems with their reason", () => {
    expect(findingFor(step({ status: "failed", detail: "The app isn't connected or needs to be re-authorized." }))).toMatchObject({
      text: "Hit a snag: The app isn't connected or needs to be re-authorized.",
      tone: "problem",
    });
    expect(
      findingFor(
        step({
          app: "granola",
          preview: { type: "text", query: "Franzi", text: "I’ll review recent meetings involving Franzi. **9 meetings** between Jul 23 and Oct 8 mention Franzi." },
        }),
      )?.text,
    ).toBe("Granola · “Franzi” — 9 meetings between Jul 23 and Oct 8 mention Franzi.");
    expect(findingFor(step({ app: "granola", preview: { type: "text", text: "Let me check." } }))?.text).toBe("Granola: answer ready");
  });

  it("has nothing to say for steps without a receipt or still running", () => {
    expect(findingFor(step({ preview: undefined }))).toBeNull();
    expect(findingFor(step({ status: "running", preview: { type: "text", text: "x" } }))).toBeNull();
    expect(findingFor(step({ preview: { type: "code", language: "python", code: "x" } }))).toBeNull();
  });

  it("lists files the agent made", () => {
    expect(findingForArtifact({ id: "a", kind: "spreadsheet", title: "Inventory", source: "Google Sheets", url: "https://docs.google.com/x" })).toMatchObject({
      text: "Made “Inventory” in Google Sheets",
      app: "sheets",
    });
  });
});

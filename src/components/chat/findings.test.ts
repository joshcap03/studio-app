import { describe, expect, it } from "vitest";
import type { ActivityStep } from "@/lib/types";
import { chunkFindings, findingFor, findingForArtifact, findingsForReply, summaryFromAgent } from "./findings";

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
    expect(findingFor(step({ app: "tracker", label: "Updated the plan", preview: { type: "text", text: "Plan: 1 of 3 steps done" } }))?.text).toBe("Plan: 1 of 3 steps done");
    expect(findingFor(step({ app: "library", action: "write", preview: { type: "text", text: "Saved “Budget” to your Library" } }))?.text).toBe(
      "Saved “Budget” to your Library",
    );
    expect(findingFor(step({ app: "memory", label: "Checked what I know about you", preview: { type: "text", text: "Fiscal year starts in February" } }))?.text).toBe(
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
    // An app that simply isn't connected isn't a snag.
    expect(findingFor(step({ status: "failed", detail: "Google Calendar isn't connected." }))).toMatchObject({
      text: "Google Calendar isn't connected.",
      tone: "normal",
    });
    expect(findingFor(step({ app: "granola", preview: { type: "text", query: "Franzi", text: '<requestedrange timerange="custom"> raw' } }))?.text).toBe(
      "Looked through Granola for “Franzi”",
    );
    expect(findingFor(step({ app: "granola", preview: { type: "text", query: "List all of my job interviews with dates and outcomes", text: "x" } }))?.text).toBe(
      "Looked through Granola",
    );
  });

  it("has nothing to say for steps without a receipt or still running", () => {
    expect(findingFor(step({ preview: undefined }))).toBeNull();
    expect(findingFor(step({ status: "running", preview: { type: "text", text: "x" } }))).toBeNull();
    expect(findingFor(step({ preview: { type: "code", language: "python", code: "x" } }))).toMatchObject({ generic: true });
  });

  it("headlines a free-form answer with the agent's own line about it", () => {
    const steps: ActivityStep[] = [
      step({ id: "a", app: "granola", preview: { type: "text", text: "The content below is meeting notes…" } }),
      step({ id: "n", app: "agent", action: "note", label: "Found 9 meetings about interviews. Let me see what they cover." }),
      step({ id: "b", app: "granola", preview: { type: "text", text: "<requestedrange …>" } }),
    ];
    expect(findingsForReply(steps, []).map((f) => f.text)).toEqual(["Found 9 meetings about interviews.", "Looked through Granola"]);
    expect(summaryFromAgent("Let me check the transcripts next.")).toBeUndefined();
    expect(summaryFromAgent("The Oct 1–12 results don't include Aaru, so I'll widen the search to all dates.")).toBe(
      "The Oct 1–12 results don't include Aaru.",
    );
  });

  it("lists files the agent made", () => {
    expect(findingForArtifact({ id: "a", kind: "spreadsheet", title: "Inventory", source: "Google Sheets", url: "https://docs.google.com/x" })).toMatchObject({
      text: "Made “Inventory” in Google Sheets",
      app: "sheets",
    });
  });

  it("puts what was found first and folds the looking into one line per app", () => {
    const web = (id: string, urls: string[], total?: number) =>
      step({
        id,
        app: "web",
        preview: { type: "sources", total, items: urls.map((u) => ({ title: u, url: `https://${u}/x`, domain: u })) },
      });
    const steps: ActivityStep[] = [
      web("w1", ["jobs.ashbyhq.com", "linkedin.com"]),
      step({ id: "g1", app: "granola", preview: { type: "text", text: "raw" } }),
      web("w2", ["jobs.ashbyhq.com", "builtin.com", "linkedin.com/b"], 5),
      step({ id: "t1", app: "tracker", label: "Tracked “Acme — PM”", preview: { type: "text", text: "Tracked “Acme — PM” (discovered)" } }),
      step({ id: "g2", app: "granola", preview: { type: "text", text: "raw" } }),
      step({ id: "x", app: "gmail", status: "failed", detail: "Gmail timed out." }),
    ];
    const chunks = chunkFindings(findingsForReply(steps, [{ id: "a", kind: "document", title: "Shortlist", source: "Google Docs", url: "https://d/x" }]));
    expect(chunks.map((c) => (c.kind === "finding" ? c.finding.text : c.text))).toEqual([
      "Tracked “Acme — PM” (discovered)",
      "Hit a snag: Gmail timed out.",
      "Made “Shortlist” in Google Docs",
      // One URL read twice counts once; the second search's unlisted 2 still count.
      "Read 6 sources across 2 searches",
      "Looked through Granola 2 times",
    ]);
    const research = chunks[3];
    expect(research.kind === "research" && research.detail).toBe("jobs.ashbyhq.com, linkedin.com, builtin.com and 1 more site");
    expect(research.kind === "research" && research.sources?.items).toHaveLength(4);
  });

  it("leaves a lone lookup as its own line", () => {
    const steps: ActivityStep[] = [
      step({ id: "w", app: "web", preview: { type: "sources", items: [{ title: "A", url: "https://a.example/", domain: "a.example" }] } }),
      step({ id: "t", app: "tracker", preview: { type: "text", text: "Tracked “B”" } }),
    ];
    expect(chunkFindings(findingsForReply(steps, [])).map((c) => c.kind === "finding" && c.finding.text)).toEqual(["Tracked “B”", "Read 1 source: a.example"]);
  });
});

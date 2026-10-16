import { describe, expect, it } from "vitest";
import type { ActivityStep } from "@/lib/types";
import { buildTimeline, linksSeen } from "./timeline";

const step = (urls: string[]): ActivityStep => ({
  id: "s1",
  label: "Read orders",
  status: "done",
  startedAt: 0,
  preview: { type: "items", items: urls.map((url, i) => ({ primary: `Item ${i}`, url })) },
});

describe("buildTimeline", () => {
  const seen = linksSeen([step(["https://shop.example/orders/1", "https://mail.example/t/2"])], [
    { id: "a1", kind: "spreadsheet", title: "Sales", url: "https://docs.example/sheet" },
  ]);

  it("orders events oldest first and keeps causes pointing at the same events", () => {
    const timeline = buildTimeline(
      {
        question: "Why did sales dip?",
        entries: [
          { when: "2026-10-06", what: "Refund", app: "shopify", url: "https://shop.example/orders/1" },
          { when: "2026-10-04", what: "Supplier delay", app: "gmail", url: "https://mail.example/t/2" },
          { when: "sometime", what: "Undated note" },
        ],
        causes: [{ text: "Stock ran out", entries: [1, 0, 1, 9] }],
      },
      seen,
    );
    expect(timeline?.entries.map((e) => e.what)).toEqual(["Supplier delay", "Refund", "Undated note"]);
    expect(timeline?.causes).toEqual([{ text: "Stock ran out", entries: [0, 1] }]);
  });

  it("links only records this run's tools returned, and marks the rest unverified", () => {
    const timeline = buildTimeline(
      {
        question: "q",
        entries: [
          { when: "2026-10-01", what: "Seen", url: "https://shop.example/orders/1" },
          { when: "2026-10-02", what: "Made up", url: "https://shop.example/orders/999" },
          { when: "2026-10-03", what: "Not https", url: "http://mail.example/t/2" },
          { when: "2026-10-04", what: "A file it made", url: "https://docs.example/sheet" },
          { when: "2026-10-05", what: "No link" },
        ],
      },
      seen,
    );
    expect(timeline?.entries.map((e) => [e.what, e.url, e.verified])).toEqual([
      ["Seen", "https://shop.example/orders/1", true],
      ["Made up", undefined, false],
      ["Not https", undefined, false],
      ["A file it made", "https://docs.example/sheet", true],
      ["No link", undefined, false],
    ]);
  });

  it("maps toolkit slugs to app ids and drops malformed ones", () => {
    const timeline = buildTimeline({ entries: [{ when: "2026-10-01", what: "x", app: "GMAIL" }, { when: "2026-10-02", what: "y", app: "googlesheets" }] }, seen);
    expect(timeline?.entries.map((e) => e.app)).toEqual([undefined, expect.any(String)]);
  });

  it("reads entries whose keys the model named its own way", () => {
    const timeline = buildTimeline(
      {
        question: "Trip plans for December",
        entries: [{ date: "2026-10-05", event: "Reservation request received", link: "https://mail.example/t/2" }],
      },
      seen,
    );
    expect(timeline?.entries).toEqual([
      { when: "2026-10-05", what: "Reservation request received", url: "https://mail.example/t/2", verified: true },
    ]);
    expect(timeline?.causes).toEqual([]);
  });

  it("returns nothing for empty or malformed timelines", () => {
    expect(buildTimeline({ entries: [] }, seen)).toBeNull();
    expect(buildTimeline({ entries: "nope" }, seen)).toBeNull();
    expect(buildTimeline(null, seen)).toBeNull();
    expect(buildTimeline({ entries: [{ when: "", what: "" }] }, seen)).toBeNull();
  });
});

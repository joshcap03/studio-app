import { describe, expect, it } from "vitest";
import { buildVisual, withVisual } from "./visuals";

describe("buildVisual", () => {
  it("keeps a chart's series aligned with its labels and reads numbers written as text", () => {
    const chart = buildVisual({
      kind: "chart",
      title: "Daily revenue",
      app: "shopify",
      chart: "line",
      unit: "$",
      labels: ["Oct 1", "Oct 2", "Oct 3"],
      series: [
        { name: "Revenue", values: ["$1,200", 980, null] },
        { name: "Too short", values: [1, 2] },
      ],
    });
    expect(chart).toEqual({
      title: "Daily revenue",
      app: "shopify",
      kind: "chart",
      chart: "line",
      unit: "$",
      labels: ["Oct 1", "Oct 2", "Oct 3"],
      series: [{ name: "Revenue", values: [1200, 980, null] }],
    });
  });

  it("drops charts with no numbers, and unknown kinds", () => {
    expect(buildVisual({ kind: "chart", title: "x", labels: ["a", "b"], series: [{ name: "s", values: ["n/a", null] }] })).toBeNull();
    expect(buildVisual({ kind: "pie", title: "x" })).toBeNull();
    expect(buildVisual("chart")).toBeNull();
  });

  it("keeps stats and pads table rows to the columns", () => {
    expect(
      buildVisual({ kind: "stats", title: "Week", items: [{ label: "Orders", value: 23, change: "-31%", tone: "bad" }, { label: "" }] }),
    ).toEqual({ title: "Week", kind: "stats", items: [{ label: "Orders", value: "23", change: "-31%", tone: "bad" }] });
    expect(buildVisual({ kind: "table", title: "Bookings", columns: ["Date", "What"], rows: [["Dec 27"], ["", ""]] })).toEqual({
      title: "Bookings",
      kind: "table",
      columns: ["Date", "What"],
      rows: [["Dec 27", ""]],
    });
  });
});

describe("withVisual", () => {
  it("starts an investigation when there's no timeline and skips repeats", () => {
    const visual = buildVisual({ kind: "stats", title: "Week", items: [{ label: "Orders", value: "23" }] })!;
    const once = withVisual(null, visual);
    expect(once).toEqual({ question: "", entries: [], causes: [], visuals: [visual] });
    expect(withVisual(once, visual)).toBe(once);
  });
});

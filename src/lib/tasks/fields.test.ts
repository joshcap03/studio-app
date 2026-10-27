import { describe, expect, it } from "vitest";
import { detailCells, detailColumns, fieldsByCollection, isBlankValue, shownFields, withoutBlanks } from "./fields";

const row = (title: string, fields: Record<string, unknown>, status: string | null = "discovered") => ({ title, status, fields });

describe("isBlankValue", () => {
  it("reads empty values and the agent's placeholders as nothing", () => {
    for (const value of [null, undefined, "", "  ", "None", "none.", "N/A", "unknown", "—", "Not listed", "not specified", [], ["", "n/a"], {}, { a: null }]) {
      expect(isBlankValue(value), String(value)).toBe(true);
    }
    for (const value of [0, false, "Remote", "None of the above", "Not listed on LinkedIn, only the careers page", ["Remote"], { a: 1 }]) {
      expect(isBlankValue(value), String(value)).toBe(false);
    }
  });

  it("drops them from what's saved, keeping the rest", () => {
    expect(withoutBlanks({ pay: "$150K", next_step: "None", score: 0, notes: "" })).toEqual({ pay: "$150K", score: 0 });
  });
});

describe("shownFields", () => {
  it("leaves out blanks, what the title or status already says, and what isn't text", () => {
    const shown = shownFields(
      row("Product Manager - Acme", { company: "Acme", pay: "$150K", next_step: "None", stage: "Discovered", tags: ["b2b", "ai"], raw: { a: 1 }, remote: true }),
    );
    expect(shown).toEqual([
      ["pay", "$150K"],
      ["tags", "b2b, ai"],
      ["remote", "yes"],
    ]);
  });
});

describe("detailColumns", () => {
  it("picks the short fields most rows have, the same for every row, and leaves long ones for the open row", () => {
    const long = "A long note about the role that goes well past what a details line can hold.";
    const rows = [
      row("PM - Acme", { company: "Acme", pay: "$150K", location: "Remote", notes: long, next_step: "None" }),
      row("PM - Beta", { location: "NYC", pay: "$160K", notes: long }),
      row("PM - Gamma", { pay: "$170K", experience: "3 years", notes: long }),
      row("PM - Delta", { next_step: "Apply", pay: "$140K" }),
      row("PM - Epsilon", { score: 4, verdict: "kept", notes: long }),
      row("PM - Zeta", { notes: long }),
    ];
    const columns = detailColumns(rows, 2);
    expect(columns).toEqual(["pay", "location"]);
    expect(rows.map((r) => detailCells(r, columns))).toEqual([
      ["$150K", "Remote"],
      ["$160K", "NYC"],
      ["$170K", ""],
      ["$140K", ""],
      ["", ""],
      ["", ""],
    ]);
  });
});

describe("fieldsByCollection", () => {
  it("lists each collection's field names, most used first, without ones only ever blank", () => {
    const rows = [
      { collection: "roles", ...row("A", { pay: "$1", location: "NYC", next_step: "None" }) },
      { collection: "roles", ...row("B", { pay: "$2" }) },
      { collection: "contacts", ...row("C", { company: "Acme" }) },
    ];
    expect(fieldsByCollection(rows)).toEqual([
      { collection: "roles", fields: ["pay", "location"] },
      { collection: "contacts", fields: ["company"] },
    ]);
  });
});

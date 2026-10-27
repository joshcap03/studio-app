import { describe, expect, it } from "vitest";
import { cellText, fieldKey, sheetColumns, fieldsByCollection, isBlankValue, shownFields, withoutBlanks } from "./fields";

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

describe("sheetColumns", () => {
  it("lists every field the rows have, short ones most rows have first and long ones last", () => {
    const long = "A long note about the role that goes well past what a narrow column can hold.";
    const rows = [
      row("PM - Acme", { company: "Acme", pay: "$150K", location: "Remote", notes: long, next_step: "None" }),
      row("PM - Beta", { location: "NYC", pay: "$160K", notes: long }),
      row("PM - Gamma", { pay: "$170K", experience: "3 years", notes: long }),
      row("PM - Delta", { next_step: "Apply", pay: "$140K" }),
    ];
    expect(sheetColumns(rows)).toEqual([
      { key: "pay", long: false },
      { key: "location", long: false },
      { key: "company", long: false },
      { key: "experience", long: false },
      { key: "next_step", long: false },
      { key: "notes", long: true },
    ]);
  });
});

describe("cellText", () => {
  it("reads a value as a cell's text, blank for placeholders and null for what isn't text", () => {
    expect(cellText("  NYC  hybrid ")).toBe("NYC hybrid");
    expect(cellText(4)).toBe("4");
    expect(cellText(["a", "b"])).toBe("a, b");
    expect(cellText("n/a")).toBe("");
    expect(cellText(undefined)).toBe("");
    expect(cellText({ min: 1, max: 2 })).toBeNull();
  });
});

describe("fieldKey", () => {
  it("turns a typed column name into a field key like the agent's", () => {
    expect(fieldKey(" Next step ")).toBe("next_step");
    expect(fieldKey("Pay ($)")).toBe("pay");
    expect(fieldKey("Café / Bar")).toBe("café_bar");
    expect(fieldKey("!!")).toBe("");
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

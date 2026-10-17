import { describe, expect, it } from "vitest";
import { catalogEntry } from "@/lib/skills/catalog";
import { DEFAULT_TEMPLATE_ID, TEMPLATES, templateById } from "./index";

describe("templates", () => {
  it("have unique ids and only reference library skills that exist", () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    for (const t of TEMPLATES) {
      expect(t.id).toMatch(/^[a-z0-9-]{1,40}$/);
      for (const skill of t.skills) expect(catalogEntry(skill), `${t.id} → ${skill}`).toBeDefined();
      expect(new Set(t.skills).size).toBe(t.skills.length);
    }
  });

  it("include the default and look up by id", () => {
    expect(templateById(DEFAULT_TEMPLATE_ID)).toBeDefined();
    expect(templateById("nope")).toBeUndefined();
    expect(templateById(null)).toBeUndefined();
  });
});

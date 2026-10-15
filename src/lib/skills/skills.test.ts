import { describe, expect, it } from "vitest";
import { APPS } from "@/lib/apps";
import { MAX_SKILL_DESCRIPTION_LENGTH, MAX_SKILL_INSTRUCTIONS_LENGTH, MAX_SKILL_NAME_LENGTH } from "@/lib/types";
import { CATALOG, CATALOG_CATEGORIES } from "./catalog";
import { draftFromConversation, renderSkillMessage } from "./render";
import { createSkillBody } from "./schema";

describe("skill library", () => {
  it("has unique ids and fits the database limits", () => {
    expect(new Set(CATALOG.map((e) => e.id)).size).toBe(CATALOG.length);
    for (const e of CATALOG) {
      expect(e.name.length, e.id).toBeLessThanOrEqual(MAX_SKILL_NAME_LENGTH);
      expect(e.description.length, e.id).toBeLessThanOrEqual(MAX_SKILL_DESCRIPTION_LENGTH);
      expect(e.instructions.length, e.id).toBeLessThanOrEqual(MAX_SKILL_INSTRUCTIONS_LENGTH);
      expect(CATALOG_CATEGORIES).toContain(e.category);
      for (const app of e.apps) expect(Object.keys(APPS), e.id).toContain(app);
    }
  });

  it("passes the same validation as an owner's own skill", () => {
    for (const e of CATALOG) {
      const parsed = createSkillBody.safeParse({ name: e.name, description: e.description, instructions: e.instructions });
      expect(parsed.success, e.id).toBe(true);
    }
  });

  it("stays generic: no links or addresses tied to one business", () => {
    expect(JSON.stringify(CATALOG)).not.toMatch(/https?:\/\/|@/);
  });
});

describe("renderSkillMessage", () => {
  const skill = { name: "Weekly sales report", instructions: "1. Pull orders.\n2. Summarize." };

  it("puts the skill's instructions before the user's request", () => {
    const text = renderSkillMessage(skill, "  for March  ");
    expect(text).toBe(
      'Use the skill "Weekly sales report" for this request.\n\nSkill instructions:\n1. Pull orders.\n2. Summarize.\n\nRequest:\nfor March',
    );
  });

  it("works without any added details", () => {
    expect(renderSkillMessage(skill, "")).toContain("Request: go ahead with the skill as written.");
  });
});

describe("draftFromConversation", () => {
  it("numbers the user's requests as steps", () => {
    expect(draftFromConversation("Restock", ["Check stock", " ", "Make a reorder sheet"])).toEqual({
      name: "Restock",
      description: "",
      instructions: "1. Check stock\n2. Make a reorder sheet",
    });
  });
});

import { describe, expect, it } from "vitest";
import { INTRODUCE_SKILL_ID, introduceSkill } from "./introduce";
import { BUILTIN_SKILL_IDS } from "./builtin";

describe("introduceSkill", () => {
  it("asks for a short, true introduction and a name through the proposal card", () => {
    const skill = introduceSkill({ member: "Sam", voiceName: null, taken: [] });
    expect(skill.id).toBe(INTRODUCE_SKILL_ID);
    expect(BUILTIN_SKILL_IDS).toContain(INTRODUCE_SKILL_ID);
    expect(skill.instructions).toContain("using Sam");
    expect(skill.instructions).toContain("Never invent");
    expect(skill.instructions).toContain("propose_agent");
    expect(skill.instructions).toContain("Not Sam (their own name).");
    expect(skill.instructions).not.toContain("on calls");
  });

  it("offers to keep the name they've heard on calls, and steers clear of their other agents' names", () => {
    const skill = introduceSkill({ member: null, voiceName: "Rowan", taken: ["June"] });
    expect(skill.instructions).toContain('suggest keeping "Rowan"');
    expect(skill.instructions).toContain("June (another of their agents)");
    expect(skill.instructions).toContain("Introduce yourself to them properly.");
  });
});

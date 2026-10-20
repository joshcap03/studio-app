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
    // A hello, not their file read back, with the name offered once, in words, right above the card.
    expect(skill.instructions).toContain("end with one sentence offering the name");
    expect(skill.instructions).toContain("Don't read their instructions");
    expect(skill.instructions).toContain("Don't name yourself before the call");
    expect(skill.instructions).not.toMatch(/keep the name or pick/);
  });

  it("offers to keep the name they've heard on calls, and steers clear of their other agents' names", () => {
    const skill = introduceSkill({ member: null, voiceName: "Rowan", taken: ["June"] });
    expect(skill.instructions).toContain('keep "Rowan" unless another name clearly fits better');
    expect(skill.instructions).toContain("say they've heard you by it on calls");
    expect(skill.instructions).toContain("June (another of their agents)");
    expect(skill.instructions).toContain("Introduce yourself to them.");
  });

  it("passes on the manner the member already has, word for word", () => {
    const fresh = introduceSkill({ member: "Sam", voiceName: "Rowan", taken: [] });
    expect(fresh.instructions).toContain("two first-person sentences on how you talk with them");
    const chosen = introduceSkill({ member: "Sam", voiceName: "Rowan", manner: "I keep it short.", taken: [] });
    expect(chosen.instructions).toContain('how you already talk with them, word for word: "I keep it short." It\'s theirs and stays as it is, so don\'t reword it.');
    expect(chosen.instructions).not.toContain("two first-person sentences on how you talk with them");
    expect(chosen.instructions).not.toContain("change only that part");
  });
});

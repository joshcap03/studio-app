import { describe, expect, it } from "vitest";
import { SUCCESS_STEP, TEMPLATES, setupSteps } from "@/lib/templates";
import { CATALOG } from "./catalog";
import { SETUP_SKILL_ID, setupSkill } from "./setup";

describe("setupSkill", () => {
  it("runs the agent's template's steps, in order, with the ids the agent proposes by", () => {
    const template = TEMPLATES.find((t) => t.id === "job-search")!;
    const skill = setupSkill("job-search");
    expect(skill.id).toBe(SETUP_SKILL_ID);
    expect(skill.description).toBe(template.setup.intro);
    const at = setupSteps(template).map((s) => skill.instructions.indexOf(`. ${s.title}: ${s.goal}`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(skill.instructions).toContain(`about ${template.setup.steps.length + 1} quick steps`);
    for (const task of template.tasks) expect(skill.instructions).toContain(`- ${task.id}: ${task.title}`);
    for (const entry of CATALOG) expect(skill.instructions).toContain(`- ${entry.id}: ${entry.name}.`);
    expect(skill.instructions).toContain("Weekdays at 8:00 AM");
  });

  it("opens every setup by having the owner define success, before anything is planned", () => {
    for (const template of TEMPLATES) {
      const skill = setupSkill(template.id).instructions;
      expect(skill).toContain(`1. ${SUCCESS_STEP.title}: `);
      expect(skill).toContain(template.setup.successExample.crisp);
      expect(skill).not.toContain("{vague}");
      expect(skill).toContain("What success means");
      // The template's steps ask about the job only through the bar, never a menu of chores.
      for (const s of template.setup.steps) expect(s.goal).not.toMatch(/What should I (do|help with)/);
    }
  });

  it("falls back to starting from scratch for an unknown or missing template", () => {
    const blank = setupSkill("blank").instructions;
    expect(setupSkill(null).instructions).toBe(blank);
    expect(setupSkill("no-such-template").instructions).toBe(blank);
    expect(blank).not.toContain("Tasks this agent already has");
  });
});

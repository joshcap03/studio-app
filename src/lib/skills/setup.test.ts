import { describe, expect, it } from "vitest";
import { DISCOVERY_STEP, PLAN_STEP, SUCCESS_STEP, TEMPLATES, setupSteps } from "@/lib/templates";
import { VOICES } from "@/lib/voice/voices";
import { CATALOG } from "./catalog";
import { SETUP_SKILL_ID, setupSkill } from "./setup";

describe("setupSkill", () => {
  it("runs the agent's template's steps, in order, with the ids the agent proposes by", () => {
    const template = TEMPLATES.find((t) => t.id === "job-search")!;
    const skill = setupSkill("job-search");
    expect(skill.id).toBe(SETUP_SKILL_ID);
    expect(skill.description).toBe(template.setup.intro);
    const at = setupSteps(template).map((s) => skill.instructions.indexOf(`${s.goal}`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const task of template.tasks) expect(skill.instructions).toContain(`- ${task.id}: ${task.title}`);
    for (const entry of CATALOG) expect(skill.instructions).toContain(`- ${entry.id}: ${entry.name}.`);
    expect(skill.instructions).toContain("Weekdays at 8:00 AM");
  });

  it("opens every setup with a conversation about what they're after, then their bar, before anything is planned", () => {
    for (const template of TEMPLATES) {
      const skill = setupSkill(template.id).instructions;
      expect(skill).toContain(`1. ${DISCOVERY_STEP.title}: `);
      expect(skill).toContain(template.setup.usualHelp);
      // Only gathering (e.g. a résumé) sits between discovery and the bar.
      expect(skill).toContain(`${(template.setup.before?.length ?? 0) + 2}. ${SUCCESS_STEP.title}: `);
      for (const s of template.setup.before ?? []) expect(s.goal).not.toMatch(/propose_agent|update_plan/);
      expect(skill).toContain(template.setup.successExample.crisp);
      expect(skill).not.toMatch(/\{(vague|crisp|usual|craft)\}/);
      // After the bar, it writes out its plan with what it knows of doing the job well, and asks
      // for their advice before it proposes anything.
      expect(skill.indexOf(`. ${PLAN_STEP.title}: `)).toBeGreaterThan(skill.indexOf(`. ${SUCCESS_STEP.title}: `));
      expect(skill).toContain(template.setup.craft);
      expect(skill).toContain(`a "How I'll do it" section`);
      expect(skill).toMatch(/three steps:[^\n]*how to do it well/);
      // Nothing hands them a stock menu of jobs: the agent designs its forms from what it learns.
      expect(skill).toContain("No form in the first reply");
      // On a call the voice has greeted them already, so the first reply just asks.
      const call = setupSkill(template.id, { call: true }).instructions;
      expect(skill).toContain("begins with that greeting");
      expect(call).not.toMatch(/\bHey\b/);
      expect(call).not.toContain(template.setup.intro);
      expect(call).toContain("just your first open question");
      expect(call.slice(call.indexOf("- Go step by step"))).toBe(skill.slice(skill.indexOf("- Go step by step")).replace(` ${template.setup.intro}`, "").replace("Your first reply opens with your greeting (see above). ", "Your first reply is just your first question (see above). "));
      expect(skill).toMatch(/Trial run[\s\S]*verdict field/);
      expect(skill).toMatch(/rank field/);
      expect(skill).toContain("Do the first one now");
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

  it("offers ways to sound side by side only to members with voice, with the voices it may use", () => {
    const typed = setupSkill("job-search").instructions;
    const voiced = setupSkill("job-search", { voice: true }).instructions;
    expect(typed).not.toContain("How you'll sound");
    expect(voiced.startsWith(typed)).toBe(true);
    for (const v of VOICES) expect(voiced).toContain(`- ${v.key}: ${v.label}. ${v.description}`);
    // Their choice, whatever their rules on advice: no pick marked, and the name isn't part of it.
    expect(voiced).toContain("two or three ways you could sound as sound");
    expect(voiced).toContain("don't mark one as yours or say which you'd pick");
    expect(voiced).toContain("Your name isn't part of this.");
    expect(setupSkill("job-search", { call: true, voice: true }).instructions).toContain("How you'll sound");
  });
});

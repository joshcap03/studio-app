import { describe, expect, it } from "vitest";
import { toolkitForApp } from "@/lib/apps";
import { catalogEntry } from "@/lib/skills/catalog";
import { taskScheduleSchema } from "@/lib/tasks/schedule";
import { MAX_TASK_INSTRUCTIONS_LENGTH, MAX_TASK_TITLE_LENGTH } from "@/lib/tasks/schema";
import { DEFAULT_TEMPLATE_ID, PLAN_STEP, TEMPLATES, setupSteps, templateById } from "./index";

describe("templates", () => {
  it("have unique ids and only reference library skills that exist", () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    for (const t of TEMPLATES) {
      expect(t.id).toMatch(/^[a-z0-9-]{1,40}$/);
      for (const skill of t.skills) expect(catalogEntry(skill), `${t.id} → ${skill}`).toBeDefined();
      expect(new Set(t.skills).size).toBe(t.skills.length);
    }
  });

  it("each ship a setup interview that asks through the reusable cards and ends in a proposal", () => {
    for (const t of TEMPLATES) {
      const steps = [...(t.setup.before ?? []), ...t.setup.steps];
      expect(t.setup.intro.trim(), t.id).not.toBe("");
      expect(t.setup.usualHelp.trim(), t.id).not.toBe("");
      expect(t.setup.craft.trim(), t.id).not.toBe("");
      expect(steps.length, t.id).toBeGreaterThanOrEqual(2);
      expect(new Set(steps.map((s) => s.id)).size, t.id).toBe(steps.length);
      for (const s of steps) {
        expect(s.id).toMatch(/^[a-z0-9-]{1,40}$/);
        // Short enough for the checklist the agent keeps with update_plan (200 chars a step).
        expect(s.title.length).toBeLessThanOrEqual(40);
      }
      // Steps say what to learn, not which fields to show; the last proposes the agent's setup.
      expect(steps.at(-1)!.goal, t.id).toContain("propose_agent");
      // Every agent works out how to do the job well with the member, right after the bar.
      expect(steps.map((s) => s.id), t.id).not.toContain(PLAN_STEP.id);
      expect(setupSteps(t).map((s) => s.id).indexOf(PLAN_STEP.id), t.id).toBe((t.setup.before?.length ?? 0) + 2);
      for (const c of t.contextCollections ?? []) expect(c).toMatch(/^[a-z0-9_-]{1,40}$/);
    }
  });

  it("have valid tasks whose skills the template adds", () => {
    for (const t of TEMPLATES) {
      expect(new Set(t.tasks.map((task) => task.id)).size).toBe(t.tasks.length);
      for (const task of t.tasks) {
        expect(task.id).toMatch(/^[a-z0-9-]{1,80}$/);
        expect(task.title.length).toBeLessThanOrEqual(MAX_TASK_TITLE_LENGTH);
        expect(task.instructions.length).toBeLessThanOrEqual(MAX_TASK_INSTRUCTIONS_LENGTH);
        if (task.schedule) expect(taskScheduleSchema.parse(task.schedule)).toEqual(task.schedule);
        if (task.skill) expect(t.skills, `${t.id} → ${task.id}`).toContain(task.skill);
      }
    }
  });

  it("suggest apps a member can connect", () => {
    for (const t of TEMPLATES) {
      for (const app of [...t.apps, ...(t.optionalApps ?? [])]) expect(toolkitForApp(app), `${t.id} → ${app}`).toBeDefined();
    }
  });

  it("set up job search with its prospecting apps and scheduled tasks", () => {
    const job = templateById("job-search")!;
    expect(job.apps).toEqual(expect.arrayContaining(["gmail", "apollo", "hunter"]));
    expect(job.optionalApps).toEqual(["clay"]);
    expect(job.tasks.map((t) => [t.id, t.schedule])).toEqual([
      ["find-new-roles", { every: "weekdays", at: "08:00" }],
      ["check-replies", { every: "weekdays", at: "12:00" }],
      ["weekly-pipeline-review", { every: "week", weekday: 1, at: "09:00" }],
      ["interview-prep", null],
    ]);
  });

  it("include the default and look up by id", () => {
    expect(templateById(DEFAULT_TEMPLATE_ID)).toBeDefined();
    expect(templateById("nope")).toBeUndefined();
    expect(templateById(null)).toBeUndefined();
  });
});

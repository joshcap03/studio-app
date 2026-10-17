import { describe, expect, it } from "vitest";
import { taskScheduleSchema, type TaskSchedule } from "@/lib/tasks/schedule";
import { draftFrom, scheduleFrom, scheduleText, taskSkills } from "./shared";

describe("schedule picker", () => {
  it("round-trips every kind of schedule", () => {
    const schedules: (TaskSchedule | null)[] = [
      null,
      { every: "day", at: "07:15" },
      { every: "weekdays", at: "08:00" },
      { every: "week", at: "14:30", weekday: 3 },
      { every: "hours", hours: 6 },
    ];
    for (const schedule of schedules) expect(scheduleFrom(draftFrom(schedule))).toEqual(schedule);
  });

  it("only sends fields the chosen kind uses, and keeps hours in range", () => {
    const draft = { ...draftFrom({ every: "week", at: "09:00", weekday: 5 }), kind: "day" as const };
    expect(scheduleFrom(draft)).toEqual({ every: "day", at: "09:00" });
    for (const hours of [0, -3, 99, 2.6, Number.NaN]) {
      const schedule = scheduleFrom({ ...draft, kind: "hours", hours });
      expect(taskScheduleSchema.safeParse(schedule).success).toBe(true);
    }
  });
});

describe("scheduleText", () => {
  it("describes on-demand tasks and survives an unknown zone", () => {
    expect(scheduleText({ schedule: null, timezone: "UTC" })).toBe("Runs when you start it");
    expect(scheduleText({ schedule: { every: "day", at: "09:00" }, timezone: "Not/AZone" })).toBe("Schedule unavailable");
    expect(scheduleText({ schedule: { every: "hours", hours: 1 }, timezone: "UTC" })).toBe("Every hour");
  });
});

describe("taskSkills", () => {
  it("leaves out built-in skills, which tasks can't reference", () => {
    const skill = { catalogId: null, name: "x", description: "", instructions: "", createdAt: 0 };
    expect(taskSkills([{ ...skill, id: "builtin:why" }, { ...skill, id: "5a2e42e8-d566-404a-8680-5f0a3a941d74" }]).map((s) => s.id)).toEqual([
      "5a2e42e8-d566-404a-8680-5f0a3a941d74",
    ]);
  });
});

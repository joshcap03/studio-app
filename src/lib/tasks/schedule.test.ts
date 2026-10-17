import { describe, expect, it } from "vitest";
import { describeSchedule, nextRun, nextRunAfter, taskScheduleSchema, type TaskSchedule } from "./schedule";

const NY = "America/New_York";

// Runs `schedule` forward from `from` and returns the next `count` run times as ISO strings.
function runs(schedule: TaskSchedule, timeZone: string, from: string, count: number): string[] {
  const out: string[] = [];
  let at = new Date(from);
  for (let i = 0; i < count; i++) {
    at = nextRun(schedule, timeZone, at);
    out.push(at.toISOString());
  }
  return out;
}

describe("nextRun", () => {
  it("runs daily at the local time, later today or tomorrow", () => {
    const daily: TaskSchedule = { every: "day", at: "08:00" };
    // 07:00 EDT → 08:00 EDT the same day.
    expect(nextRun(daily, NY, new Date("2026-06-10T11:00:00Z")).toISOString()).toBe("2026-06-10T12:00:00.000Z");
    // 09:00 EDT → tomorrow.
    expect(nextRun(daily, NY, new Date("2026-06-10T13:00:00Z")).toISOString()).toBe("2026-06-11T12:00:00.000Z");
  });

  it("is strictly after `after`", () => {
    const daily: TaskSchedule = { every: "day", at: "08:00" };
    expect(nextRun(daily, NY, new Date("2026-06-10T12:00:00Z")).toISOString()).toBe("2026-06-11T12:00:00.000Z");
    expect(nextRun(daily, NY, new Date("2026-06-10T11:59:59.999Z")).toISOString()).toBe("2026-06-10T12:00:00.000Z");
  });

  it("uses the local date, not the UTC date, near midnight", () => {
    // 2026-06-10 23:30 EDT is already 06-11 in UTC; 23:45 local is still today.
    const late: TaskSchedule = { every: "day", at: "23:45" };
    expect(nextRun(late, NY, new Date("2026-06-11T03:30:00Z")).toISOString()).toBe("2026-06-11T03:45:00.000Z");
  });

  it("skips the weekend for weekdays", () => {
    const weekdays: TaskSchedule = { every: "weekdays", at: "08:00" };
    // Friday 2026-10-16 09:00 EDT → Monday 10-19 08:00 EDT.
    expect(nextRun(weekdays, NY, new Date("2026-10-16T13:00:00Z")).toISOString()).toBe("2026-10-19T12:00:00.000Z");
    // Saturday and Sunday also land on Monday.
    expect(nextRun(weekdays, NY, new Date("2026-10-17T10:00:00Z")).toISOString()).toBe("2026-10-19T12:00:00.000Z");
    expect(nextRun(weekdays, NY, new Date("2026-10-18T23:00:00Z")).toISOString()).toBe("2026-10-19T12:00:00.000Z");
    // A full week runs Monday through Friday only.
    expect(runs(weekdays, NY, "2026-10-16T13:00:00Z", 6)).toEqual([
      "2026-10-19T12:00:00.000Z",
      "2026-10-20T12:00:00.000Z",
      "2026-10-21T12:00:00.000Z",
      "2026-10-22T12:00:00.000Z",
      "2026-10-23T12:00:00.000Z",
      "2026-10-26T12:00:00.000Z",
    ]);
  });

  it("runs weekly on the chosen local weekday", () => {
    const mondays: TaskSchedule = { every: "week", weekday: 1, at: "09:00" };
    // Monday 2026-10-19 08:00 EDT → 09:00 that day; 10:00 → the next Monday.
    expect(nextRun(mondays, NY, new Date("2026-10-19T12:00:00Z")).toISOString()).toBe("2026-10-19T13:00:00.000Z");
    expect(nextRun(mondays, NY, new Date("2026-10-19T14:00:00Z")).toISOString()).toBe("2026-10-26T13:00:00.000Z");
    const sundays: TaskSchedule = { every: "week", weekday: 0, at: "18:00" };
    expect(nextRun(sundays, NY, new Date("2026-10-19T14:00:00Z")).toISOString()).toBe("2026-10-25T22:00:00.000Z");
  });

  it("keeps the local time across spring forward", () => {
    const daily: TaskSchedule = { every: "day", at: "08:00" };
    // 2026-03-08: EST (-5) → EDT (-4).
    expect(runs(daily, NY, "2026-03-07T00:00:00Z", 3)).toEqual([
      "2026-03-07T13:00:00.000Z",
      "2026-03-08T12:00:00.000Z",
      "2026-03-09T12:00:00.000Z",
    ]);
  });

  it("moves a time skipped by spring forward to the next valid time", () => {
    // 02:30 doesn't exist on 2026-03-08 in New York; clocks jump from 02:00 EST to 03:00 EDT.
    const daily: TaskSchedule = { every: "day", at: "02:30" };
    expect(runs(daily, NY, "2026-03-07T00:00:00Z", 3)).toEqual([
      "2026-03-07T07:30:00.000Z", // 02:30 EST
      "2026-03-08T07:00:00.000Z", // 03:00 EDT
      "2026-03-09T06:30:00.000Z", // 02:30 EDT
    ]);
  });

  it("runs an ambiguous fall-back time once", () => {
    // 2026-11-01: 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST).
    const daily: TaskSchedule = { every: "day", at: "01:30" };
    expect(runs(daily, NY, "2026-10-31T00:00:00Z", 3)).toEqual([
      "2026-10-31T05:30:00.000Z", // 01:30 EDT
      "2026-11-01T05:30:00.000Z", // first 01:30, EDT
      "2026-11-02T06:30:00.000Z", // 01:30 EST, the next day
    ]);
    // Even between the two occurrences, the next run is the following day.
    expect(nextRun(daily, NY, new Date("2026-11-01T06:00:00Z")).toISOString()).toBe("2026-11-02T06:30:00.000Z");
  });

  it("keeps the local time across fall back", () => {
    const daily: TaskSchedule = { every: "day", at: "08:00" };
    expect(runs(daily, NY, "2026-10-31T00:00:00Z", 3)).toEqual([
      "2026-10-31T12:00:00.000Z",
      "2026-11-01T13:00:00.000Z",
      "2026-11-02T13:00:00.000Z",
    ]);
  });

  it("handles a half-hour zone (Asia/Kolkata, +05:30)", () => {
    const weekdays: TaskSchedule = { every: "weekdays", at: "08:00" };
    // Friday 2026-10-16 09:00 IST → Monday 10-19 08:00 IST (02:30Z).
    expect(nextRun(weekdays, "Asia/Kolkata", new Date("2026-10-16T03:30:00Z")).toISOString()).toBe(
      "2026-10-19T02:30:00.000Z",
    );
    // Sunday 18:30Z is already Monday 00:00 in Kolkata, so 08:00 that Monday.
    expect(nextRun(weekdays, "Asia/Kolkata", new Date("2026-10-18T18:30:00Z")).toISOString()).toBe(
      "2026-10-19T02:30:00.000Z",
    );
  });

  it("handles Pacific/Auckland, a day ahead of UTC, and its DST", () => {
    const mondays: TaskSchedule = { every: "week", weekday: 1, at: "09:00" };
    // Sunday 2026-10-18 21:00Z is Monday 10-19 10:00 NZDT, past 09:00 → next Monday.
    expect(nextRun(mondays, "Pacific/Auckland", new Date("2026-10-18T21:00:00Z")).toISOString()).toBe(
      "2026-10-25T20:00:00.000Z",
    );
    // Auckland springs forward on 2026-09-27 (02:00 NZST → 03:00 NZDT).
    const daily: TaskSchedule = { every: "day", at: "02:30" };
    expect(runs(daily, "Pacific/Auckland", "2026-09-25T00:00:00Z", 3)).toEqual([
      "2026-09-25T14:30:00.000Z", // 09-26 02:30 NZST (+12)
      "2026-09-26T14:00:00.000Z", // 09-27 03:00 NZDT (+13)
      "2026-09-27T13:30:00.000Z", // 09-28 02:30 NZDT
    ]);
    // And falls back on 2026-04-05 (03:00 NZDT → 02:00 NZST): 02:30 runs once.
    expect(runs(daily, "Pacific/Auckland", "2026-04-03T00:00:00Z", 3)).toEqual([
      "2026-04-03T13:30:00.000Z", // 04-04 02:30 NZDT
      "2026-04-04T13:30:00.000Z", // 04-05 first 02:30, NZDT
      "2026-04-05T14:30:00.000Z", // 04-06 02:30 NZST
    ]);
  });

  it("runs every N hours from `after`, regardless of the zone or DST", () => {
    const every4: TaskSchedule = { every: "hours", hours: 4 };
    expect(nextRun(every4, NY, new Date("2026-03-08T05:15:00Z")).toISOString()).toBe("2026-03-08T09:15:00.000Z");
    expect(nextRun(every4, "Asia/Kolkata", new Date("2026-03-08T05:15:00Z")).toISOString()).toBe(
      "2026-03-08T09:15:00.000Z",
    );
    expect(nextRun({ every: "hours", hours: 24 }, NY, new Date("2026-11-01T00:00:00Z")).toISOString()).toBe(
      "2026-11-02T00:00:00.000Z",
    );
  });

  it("rejects an unknown time zone", () => {
    expect(() => nextRun({ every: "day", at: "08:00" }, "Mars/Olympus", new Date())).toThrow(RangeError);
  });
});

describe("describeSchedule", () => {
  it("reads as plain English", () => {
    expect(describeSchedule({ every: "day", at: "08:00" }, NY)).toBe("Every day at 8:00 AM");
    expect(describeSchedule({ every: "weekdays", at: "08:00" }, NY)).toBe("Weekdays at 8:00 AM");
    expect(describeSchedule({ every: "week", weekday: 1, at: "09:00" }, NY)).toBe("Every Monday at 9:00 AM");
    expect(describeSchedule({ every: "week", weekday: 0, at: "17:30" }, NY)).toBe("Every Sunday at 5:30 PM");
    expect(describeSchedule({ every: "day", at: "00:05" }, NY)).toBe("Every day at 12:05 AM");
    expect(describeSchedule({ every: "day", at: "12:00" }, NY)).toBe("Every day at 12:00 PM");
    expect(describeSchedule({ every: "hours", hours: 4 }, NY)).toBe("Every 4 hours");
    expect(describeSchedule({ every: "hours", hours: 1 }, NY)).toBe("Every hour");
  });

  it("rejects an unknown time zone", () => {
    expect(() => describeSchedule({ every: "day", at: "08:00" }, "Not/AZone")).toThrow(RangeError);
  });
});

describe("taskScheduleSchema", () => {
  it("accepts each kind of schedule", () => {
    for (const schedule of [
      { every: "day", at: "00:00" },
      { every: "weekdays", at: "23:59" },
      { every: "week", at: "09:00", weekday: 6 },
      { every: "hours", hours: 1 },
      { every: "hours", hours: 24 },
    ]) {
      expect(taskScheduleSchema.parse(schedule)).toEqual(schedule);
    }
  });

  it("rejects invalid schedules", () => {
    for (const schedule of [
      null,
      {},
      { every: "month", at: "08:00" },
      { every: "day" },
      { every: "day", at: "8:00" },
      { every: "day", at: "24:00" },
      { every: "day", at: "08:60" },
      { every: "day", at: "08:00:00" },
      { every: "day", at: 800 },
      { every: "week", at: "09:00" },
      { every: "week", at: "09:00", weekday: 7 },
      { every: "week", at: "09:00", weekday: -1 },
      { every: "week", at: "09:00", weekday: 1.5 },
      { every: "hours" },
      { every: "hours", hours: 0 },
      { every: "hours", hours: 25 },
      { every: "hours", hours: 2.5 },
      { every: "hours", hours: "4" },
      { every: "hours", hours: 4, at: "08:00" },
      { every: "day", at: "08:00", weekday: 1 },
    ]) {
      expect(taskScheduleSchema.safeParse(schedule).success, JSON.stringify(schedule)).toBe(false);
    }
  });
});

describe("nextRunAfter", () => {
  it("steps every-N-hours tasks from the time they were due, not when they were picked up", () => {
    const due = new Date("2026-10-17T12:00:00Z");
    const now = new Date("2026-10-17T12:01:40Z");
    expect(nextRunAfter({ every: "hours", hours: 4 }, "UTC", due, now).toISOString()).toBe("2026-10-17T16:00:00.000Z");
  });

  it("doesn't make up missed times", () => {
    const due = new Date("2026-10-14T12:00:00Z");
    const now = new Date("2026-10-17T13:00:00Z");
    expect(nextRunAfter({ every: "day", at: "12:00" }, "UTC", due, now).toISOString()).toBe("2026-10-18T12:00:00.000Z");
    expect(nextRunAfter({ every: "hours", hours: 4 }, "UTC", due, now).toISOString()).toBe("2026-10-17T17:00:00.000Z");
  });
});

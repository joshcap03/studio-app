import { z } from "zod";

// When a recurring task runs. Stored as structured jsonb, not cron, and read in the member's
// own IANA time zone, so "weekdays at 8:00" means 8:00 wherever the member is, across DST.

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour HH:MM time.");

export const taskScheduleSchema = z.discriminatedUnion("every", [
  z.strictObject({ every: z.literal("day"), at: time }),
  z.strictObject({ every: z.literal("weekdays"), at: time }),
  z.strictObject({ every: z.literal("week"), at: time, weekday: z.number().int().min(0).max(6) }),
  z.strictObject({ every: z.literal("hours"), hours: z.number().int().min(1).max(24) }),
]);

export type TaskSchedule = z.infer<typeof taskScheduleSchema>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const formatters = new Map<string, Intl.DateTimeFormat>();

// Throws a RangeError for a zone Intl doesn't know.
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

// The zone's wall clock at `instant`, as if it were UTC.
function wallClock(instant: number, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(instant)) p[part.type] = Number(part.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

// How far the zone's clock is ahead of UTC at `instant`, in ms.
function offset(instant: number, timeZone: string): number {
  const whole = Math.floor(instant / 1000) * 1000;
  return wallClock(whole, timeZone) - whole;
}

// The instant the zone's clock reads `wall` (a local time encoded as UTC). An ambiguous time
// (clocks going back) resolves to its first occurrence; a time skipped by clocks going
// forward resolves to the moment the clock jumps, the next time that exists.
function toInstant(wall: number, timeZone: string): number {
  const before = offset(wall - DAY, timeZone);
  const after = offset(wall + DAY, timeZone);
  const matches = [wall - before, wall - after].filter((t) => offset(t, timeZone) === wall - t);
  if (matches.length) return Math.min(...matches);
  let lo = wall - after;
  let hi = wall - before;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2 / 1000) * 1000;
    if (offset(mid, timeZone) === after) hi = mid;
    else lo = mid;
  }
  return hi;
}

// The first instant strictly after `after` that the schedule matches, in `timeZone`.
export function nextRun(schedule: TaskSchedule, timeZone: string, after: Date): Date {
  const from = after.getTime();
  if (schedule.every === "hours") return new Date(from + schedule.hours * HOUR);

  const [hour, minute] = schedule.at.split(":").map(Number);
  const today = new Date(wallClock(from, timeZone));
  for (let d = 0; d <= 8; d++) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + d));
    const weekday = day.getUTCDay();
    if (schedule.every === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    if (schedule.every === "week" && weekday !== schedule.weekday) continue;
    const run = toInstant(day.getTime() + hour * HOUR + minute * 60_000, timeZone);
    if (run > from) return new Date(run);
  }
  throw new Error("No matching run time within a week.");
}

function clock(at: string): string {
  const [hour, minute] = at.split(":").map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

// Plain English, e.g. "Weekdays at 8:00 AM". Times are the member's local times in
// `timeZone` (an unknown zone throws, as in nextRun), which callers show alongside when it
// differs from the viewer's.
export function describeSchedule(schedule: TaskSchedule, timeZone: string): string {
  formatter(timeZone);
  switch (schedule.every) {
    case "day":
      return `Every day at ${clock(schedule.at)}`;
    case "weekdays":
      return `Weekdays at ${clock(schedule.at)}`;
    case "week":
      return `Every ${WEEKDAYS[schedule.weekday]} at ${clock(schedule.at)}`;
    case "hours":
      return schedule.hours === 1 ? "Every hour" : `Every ${schedule.hours} hours`;
  }
}

/**
 * When a task runs next after its run due at `due` was claimed at `now`: the schedule's next
 * time after `due` (so an every-N-hours task doesn't drift with dispatch delays), or after
 * `now` when times were missed, which aren't made up.
 */
export function nextRunAfter(schedule: TaskSchedule, timeZone: string, due: Date, now: Date): Date {
  const next = nextRun(schedule, timeZone, due);
  return next > now ? next : nextRun(schedule, timeZone, now);
}

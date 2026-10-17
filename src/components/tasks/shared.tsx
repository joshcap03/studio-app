"use client";

import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/client/api";
import { describeSchedule, nextRun, type TaskSchedule } from "@/lib/tasks/schedule";
import type { AgentTask, RunStatus, TaskRun, TaskStatus } from "@/lib/tasks/types";
import type { WorkspaceSkill } from "@/lib/types";

// Pieces the task list and the task page share: the schedule picker, plain-words labels for
// what the server reports, and the "needs you" check.

export const field =
  "w-full rounded-xl border border-line bg-surface px-3.5 text-[14px] text-fg outline-none transition-[border-color,box-shadow] placeholder:text-fg-4 focus:border-line-strong focus:shadow-composer focus-visible:outline-none";
export const primary =
  "inline-flex h-8 items-center gap-1.5 rounded-lg bg-inverse px-3 text-[13px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:opacity-30";
export const secondary =
  "inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] font-medium text-fg-2 transition-colors hover:border-line-strong hover:bg-hover hover:text-fg disabled:opacity-40";
export const iconButton =
  "flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-hover hover:text-fg";
export const label = "text-[13px] font-medium text-fg-2";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The viewer's IANA time zone; schedule times are read in it. */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export type ScheduleKind = "none" | TaskSchedule["every"];

/** The schedule picker's state; fields that don't apply to the chosen kind are kept, not sent. */
export interface ScheduleDraft {
  kind: ScheduleKind;
  at: string;
  weekday: number;
  hours: number;
}

export function draftFrom(schedule: TaskSchedule | null): ScheduleDraft {
  const draft: ScheduleDraft = { kind: schedule?.every ?? "none", at: "09:00", weekday: 1, hours: 4 };
  if (schedule && "at" in schedule) draft.at = schedule.at;
  if (schedule?.every === "week") draft.weekday = schedule.weekday;
  if (schedule?.every === "hours") draft.hours = schedule.hours;
  return draft;
}

export function scheduleFrom(draft: ScheduleDraft): TaskSchedule | null {
  switch (draft.kind) {
    case "none":
      return null;
    case "day":
    case "weekdays":
      return { every: draft.kind, at: draft.at };
    case "week":
      return { every: "week", at: draft.at, weekday: draft.weekday };
    case "hours":
      return { every: "hours", hours: Math.min(24, Math.max(1, Math.round(draft.hours) || 1)) };
  }
}

export function scheduleText(task: Pick<AgentTask, "schedule" | "timezone">): string {
  if (!task.schedule) return "Runs when you start it";
  try {
    const text = describeSchedule(task.schedule, task.timezone);
    return "at" in task.schedule && task.timezone !== browserZone() ? `${text} (${task.timezone.replace(/_/g, " ")})` : text;
  } catch {
    return "Schedule unavailable";
  }
}

export function formatWhen(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Tomorrow, ${time}`;
  if (days === -1) return `Yesterday, ${time}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  return `${date.toLocaleDateString(undefined, { weekday: Math.abs(days) < 7 ? "short" : undefined, month: "short", day: "numeric", year: sameYear ? undefined : "numeric" })}, ${time}`;
}

/** Just the day, e.g. "Today" or "Oct 3", for compact tables. */
export function formatDay(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const days = Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === -1) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  active: "Active",
  paused: "Paused",
  done: "Done",
  archived: "Archived",
};

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  done: "Finished",
  skipped: "Skipped",
  failed: "Failed",
};

// Reasons runs record as codes (src/lib/tasks/run-task.ts); anything else stored is already a sentence.
const RUN_REASON_TEXT: Record<string, string> = {
  waiting_on_you: "Waiting for your approval in the conversation.",
  busy: "Skipped: the agent was still working in this task's conversation.",
  paused: "Skipped: the task was paused.",
  done: "Skipped: the task was marked done.",
  archived: "Skipped: the task was archived.",
  agent_unavailable: "Skipped: this agent isn't enabled yet.",
  error: "The agent hit an error.",
  stopped: "Stopped before it finished.",
  interrupted: "Interrupted before it finished.",
};

export function runReason(run: TaskRun): string | null {
  return run.reason ? (RUN_REASON_TEXT[run.reason] ?? run.reason) : null;
}

export function RunBadge({ run }: { run: TaskRun }) {
  const waiting = run.status === "running" && run.reason === "waiting_on_you";
  const tone = run.status === "failed" ? "text-danger" : run.status === "done" ? "text-success" : waiting ? "text-accent" : "text-fg-3";
  return (
    <span className={`inline-flex items-center gap-1.5 ${tone}`}>
      {run.status === "running" && !waiting ? <span className="spinner" aria-hidden="true" /> : null}
      {waiting ? "Needs you" : RUN_STATUS_LABEL[run.status]}
    </span>
  );
}

export function StatusPill({ status }: { status: TaskStatus }) {
  const tone = status === "active" ? "border-line text-fg-2" : "border-transparent bg-subtle text-fg-3";
  return <span className={`inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[11.5px] font-medium ${tone}`}>{TASK_STATUS_LABEL[status]}</span>;
}

export function NeedsYouBadge() {
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 text-[11.5px] font-medium text-accent">
      <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
      Needs you
    </span>
  );
}

/**
 * Whether a task's conversation holds a reply waiting on the member's approval, read from the
 * messages the conversation API returns. Null while unknown or if it couldn't be read.
 */
export function useNeedsYou(conversationId: string | null): boolean | null {
  const [state, setState] = useState<{ id: string; value: boolean } | null>(null);
  useEffect(() => {
    if (!conversationId) return;
    const controller = new AbortController();
    api
      .getConversation(conversationId, controller.signal)
      .then(({ messages }) => setState({ id: conversationId, value: messages.some((m) => m.status === "awaiting") }))
      .catch(() => undefined);
    return () => controller.abort();
  }, [conversationId]);
  return conversationId && state?.id === conversationId ? state.value : null;
}

/** Skills a task can use: the workspace's own, which live in the database. */
export function taskSkills(skills: WorkspaceSkill[]): WorkspaceSkill[] {
  return skills.filter((s) => !s.id.startsWith("builtin:"));
}

export function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : "Something went wrong. Try again.";
}

export function ScheduleFields({ draft, onChange, zone }: { draft: ScheduleDraft; onChange: (draft: ScheduleDraft) => void; zone: string }) {
  const schedule = scheduleFrom(draft);
  let preview: string | null = null;
  if (schedule) {
    try {
      preview = formatWhen(nextRun(schedule, zone, new Date()).getTime());
    } catch {
      preview = null;
    }
  }
  const set = (patch: Partial<ScheduleDraft>) => onChange({ ...draft, ...patch });

  return (
    <fieldset className="space-y-3">
      <legend className={label}>Schedule</legend>
      <div className="flex flex-wrap gap-2">
        <select aria-label="How often" value={draft.kind} onChange={(e) => set({ kind: e.target.value as ScheduleKind })} className={`h-10 w-auto min-w-0 flex-1 basis-40 ${field}`}>
          <option value="none">Only when I run it</option>
          <option value="day">Every day</option>
          <option value="weekdays">Weekdays</option>
          <option value="week">Every week</option>
          <option value="hours">Every few hours</option>
        </select>
        {draft.kind === "week" ? (
          <select aria-label="Day of the week" value={draft.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })} className={`h-10 w-auto min-w-0 flex-1 basis-32 ${field}`}>
            {WEEKDAYS.map((day, i) => (
              <option key={day} value={i}>
                {day}
              </option>
            ))}
          </select>
        ) : null}
        {draft.kind === "day" || draft.kind === "weekdays" || draft.kind === "week" ? (
          <input
            type="time"
            aria-label="Time"
            required
            value={draft.at}
            onChange={(e) => set({ at: e.target.value || draft.at })}
            className={`h-10 w-auto min-w-0 flex-1 basis-28 ${field}`}
          />
        ) : null}
        {draft.kind === "hours" ? (
          <label className="flex h-10 flex-1 basis-40 items-center gap-2 text-[14px] text-fg-2">
            Every
            <input
              type="number"
              min={1}
              max={24}
              aria-label="Hours between runs"
              value={draft.hours}
              onChange={(e) => set({ hours: Number(e.target.value) })}
              className={`h-10 w-20 ${field}`}
            />
            hours
          </label>
        ) : null}
      </div>
      <p className="text-[12.5px] text-fg-3">
        {schedule ? (
          <>
            {describeSchedule(schedule, zone)}
            {"at" in schedule ? `, ${zone.replace(/_/g, " ")} time` : null}
            {preview ? ` · Next run ${preview}` : null}
          </>
        ) : (
          "Runs only when you press Run now."
        )}
      </p>
    </fieldset>
  );
}

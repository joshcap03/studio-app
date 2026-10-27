import { z } from "zod";
import { STANDING_KINDS } from "@/lib/approvals/standing";
import { MAX_GOAL_LENGTH } from "@/lib/types";
import { taskScheduleSchema } from "./schedule";

// Validation for tasks and records, used by the API routes and, later, the agent's tools.
// Limits mirror the database checks in supabase/migrations/20261024000000_agent_tasks.sql
// and stay a little under its byte caps, since JSON text and jsonb sizes differ.

export const TASK_STATUSES = ["active", "paused", "done", "archived"] as const;
export const STEP_STATUSES = ["todo", "doing", "done", "blocked", "needs_you"] as const;
export const RUN_STATUSES = ["queued", "running", "done", "skipped", "failed"] as const;

export const MAX_TASKS = 50;
export const MAX_TASK_TITLE_LENGTH = 80;
export const MAX_TASK_INSTRUCTIONS_LENGTH = 4000;
export const MAX_PLAN_STEPS = 30;
export const MAX_RECORDS_PER_COLLECTION = 500;
const MAX_PLAN_JSON = 12_000;
const MAX_FIELDS_JSON = 7_000;

const jsonSize = (value: unknown) => JSON.stringify(value).length;

export const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, "That time zone isn't recognized.");

export const planStepSchema = z.strictObject({
  id: z.string().trim().min(1).max(40),
  text: z.string().trim().min(1, "Describe the step.").max(200),
  status: z.enum(STEP_STATUSES),
  note: z.string().trim().max(300).nullable().optional(),
});

export const planSchema = z
  .array(planStepSchema)
  .max(MAX_PLAN_STEPS, `A plan can have up to ${MAX_PLAN_STEPS} steps.`)
  .refine((steps) => new Set(steps.map((s) => s.id)).size === steps.length, "Each step needs its own id.")
  .refine((steps) => jsonSize(steps) <= MAX_PLAN_JSON, "That plan is too long.");

/** What done looks like for a task, in one line ("Done means …"); empty clears it. */
export const goalSchema = z
  .string()
  .max(MAX_GOAL_LENGTH * 4)
  .transform((goal) => goal.replace(/\s+/g, " ").trim())
  .pipe(z.string().max(MAX_GOAL_LENGTH, `Keep it to ${MAX_GOAL_LENGTH} characters.`))
  .transform((goal) => goal || null)
  .nullable();

const taskFields = {
  title: z.string().trim().min(1, "Give it a title.").max(MAX_TASK_TITLE_LENGTH),
  instructions: z.string().trim().max(MAX_TASK_INSTRUCTIONS_LENGTH),
  skillId: z.uuid().nullable(),
  schedule: taskScheduleSchema.nullable(),
  timezone: timezoneSchema,
  plan: planSchema,
  conversationId: z.uuid().nullable(),
};

export const createTaskBody = z.strictObject({
  ...taskFields,
  instructions: taskFields.instructions.default(""),
  skillId: taskFields.skillId.default(null),
  schedule: taskFields.schedule.default(null),
  timezone: taskFields.timezone.default("UTC"),
  plan: taskFields.plan.default([]),
  conversationId: taskFields.conversationId.default(null),
});

export const patchTaskBody = z
  // `disallow` takes back a standing OK (src/lib/approvals/standing.ts); one is given only with a tap on a real request.
  .strictObject({ ...taskFields, status: z.enum(TASK_STATUSES), goal: goalSchema, disallow: z.enum(STANDING_KINDS) })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "Nothing to change.");

export const appendRunInput = z.strictObject({
  scheduledFor: z.coerce.date(),
  status: z.enum(RUN_STATUSES).default("queued"),
  reason: z.string().trim().max(500).nullable().default(null),
  messageId: z.uuid().nullable().default(null),
});

export const collectionSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "Use a short lowercase name, like job-applications.");

const recordFields = {
  title: z.string().trim().max(200),
  status: z.string().trim().min(1).max(40).nullable(),
  url: z
    .url({ protocol: /^https?$/, error: "Use an http(s) link." })
    .max(2000)
    .nullable(),
  fields: z
    .record(z.string(), z.unknown())
    .refine((f) => jsonSize(f) <= MAX_FIELDS_JSON, "Those fields are too large."),
};

export const upsertRecordInput = z.strictObject({
  collection: collectionSchema,
  key: z.string().trim().min(1).max(200),
  ...recordFields,
  title: recordFields.title.optional(),
  status: recordFields.status.optional(),
  url: recordFields.url.optional(),
  fields: recordFields.fields.optional(),
  taskId: z.uuid().nullable().optional(),
  sourceMessageId: z.uuid().nullable().optional(),
});

export const patchRecordBody = z
  .strictObject(recordFields)
  .partial()
  .refine((p) => Object.keys(p).length > 0, "Nothing to change.");

export type TaskDraft = z.infer<typeof createTaskBody>;
export type TaskPatch = z.infer<typeof patchTaskBody>;
export type AppendRunInput = z.input<typeof appendRunInput>;
export type RecordUpsert = z.infer<typeof upsertRecordInput>;
export type RecordPatch = z.infer<typeof patchRecordBody>;

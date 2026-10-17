import { describe, expect, it } from "vitest";
import { createTaskBody, patchRecordBody, patchTaskBody, planSchema, upsertRecordInput } from "./schema";

const step = (id: string, status = "todo") => ({ id, text: `Step ${id}`, status });

describe("task schemas", () => {
  it("fills defaults and keeps schedules structured", () => {
    expect(createTaskBody.parse({ title: " Daily scan " })).toEqual({
      title: "Daily scan",
      instructions: "",
      skillId: null,
      schedule: null,
      timezone: "UTC",
      plan: [],
      conversationId: null,
    });
    expect(createTaskBody.safeParse({ title: "x", schedule: { every: "week", at: "09:30", weekday: 1 } }).success).toBe(true);
    expect(createTaskBody.safeParse({ title: "x", schedule: { every: "week", at: "9:30" } }).success).toBe(false);
    expect(createTaskBody.safeParse({ title: "x", schedule: "0 8 * * 1-5" }).success).toBe(false);
  });

  it("refuses unknown time zones and fields the caller doesn't own", () => {
    expect(createTaskBody.safeParse({ title: "x", timezone: "Europe/Paris" }).success).toBe(true);
    expect(createTaskBody.safeParse({ title: "x", timezone: "Nowhere/Land" }).success).toBe(false);
    expect(createTaskBody.safeParse({ title: "x", workspaceId: crypto.randomUUID() }).success).toBe(false);
    expect(patchTaskBody.safeParse({ nextRunAt: 0 }).success).toBe(false);
    expect(patchTaskBody.safeParse({}).success).toBe(false);
  });

  it("caps plans at 30 steps with distinct ids", () => {
    expect(planSchema.safeParse(Array.from({ length: 30 }, (_, i) => step(String(i), "needs_you"))).success).toBe(true);
    expect(planSchema.safeParse(Array.from({ length: 31 }, (_, i) => step(String(i)))).success).toBe(false);
    expect(planSchema.safeParse([step("a"), step("a")]).success).toBe(false);
    expect(planSchema.safeParse([step("a", "maybe")]).success).toBe(false);
  });
});

describe("record schemas", () => {
  it("needs a slug collection and http(s) links", () => {
    expect(upsertRecordInput.safeParse({ collection: "job-applications", key: "https://x.test/1" }).success).toBe(true);
    expect(upsertRecordInput.safeParse({ collection: "Job Applications", key: "k" }).success).toBe(false);
    expect(patchRecordBody.safeParse({ url: "https://jobs.example.test/1" }).success).toBe(true);
    expect(patchRecordBody.safeParse({ url: "javascript:alert(1)" }).success).toBe(false);
  });

  it("keeps fields to a small object", () => {
    expect(patchRecordBody.safeParse({ fields: { company: "Example" } }).success).toBe(true);
    expect(patchRecordBody.safeParse({ fields: ["a"] }).success).toBe(false);
    expect(patchRecordBody.safeParse({ fields: { notes: "x".repeat(8000) } }).success).toBe(false);
  });
});

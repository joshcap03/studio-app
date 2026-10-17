import { describe, expect, it } from "vitest";
import { setupSteps, templateById } from "@/lib/templates";
import type { Tenant } from "@/lib/tenant-core";
import { summarizeSetup } from "./setup-state";

const tenant = (role: "owner" | "member") => ({ workspace: { id: "w", name: "Acme", role }, userId: "u" }) as unknown as Tenant;

describe("summarizeSetup", () => {
  it("shows the owner the template's steps, all to do, before the agent has written a checklist", () => {
    const summary = summarizeSetup(tenant("owner"), null, "job-search")!;
    const steps = setupSteps(templateById("job-search")!);
    expect(summary).toMatchObject({ status: "not_started", conversationId: null, done: 0, total: steps.length });
    expect(summary.plan).toEqual(steps.map((s) => ({ text: s.title, status: "todo" })));
  });

  it("shows the checklist the agent reported, with what each finished step gave it", () => {
    const plan = [
      { text: "Your bar", status: "done" as const, note: "Bar set: 6 criteria" },
      { text: "Your résumé", status: "doing" as const },
    ];
    const summary = summarizeSetup(tenant("owner"), { status: "in_progress", conversationId: "c1", plan, updatedAt: 1 }, "job-search");
    expect(summary).toEqual({ status: "in_progress", conversationId: "c1", done: 1, total: 2, plan });
  });

  it("is only for the owner", () => {
    expect(summarizeSetup(tenant("member"), null, "job-search")).toBeNull();
  });
});

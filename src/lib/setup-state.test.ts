import { describe, expect, it } from "vitest";
import { DISCOVERY_STEP, SUCCESS_STEP, setupSteps, templateById } from "@/lib/templates";
import type { Tenant } from "@/lib/tenant-core";
import { summarizeSetup, toTheBar } from "./setup-state";

const tenant = (role: "owner" | "member") => ({ workspace: { id: "w", name: "Acme", role }, userId: "u" }) as unknown as Tenant;

describe("summarizeSetup", () => {
  it("shows only the two opening steps before the agent has written a checklist, never the whole template", () => {
    const summary = summarizeSetup(tenant("owner"), null, "job-search")!;
    expect(summary).toMatchObject({ status: "not_started", conversationId: null, done: 0, total: 2 });
    expect(summary.plan).toEqual([
      { text: DISCOVERY_STEP.title, status: "todo" },
      { text: SUCCESS_STEP.title, status: "todo" },
    ]);
    expect(setupSteps(templateById("job-search")!).length).toBeGreaterThan(2);
  });

  it("shows the checklist the agent reported, with what each finished step gave it", () => {
    const plan = [
      { text: "Your bar", status: "done" as const, note: "Bar set: 6 criteria" },
      { text: "Your résumé", status: "doing" as const },
    ];
    const summary = summarizeSetup(tenant("owner"), { status: "in_progress", conversationId: "c1", plan, updatedAt: 1 }, "job-search");
    expect(summary).toEqual({ status: "in_progress", conversationId: "c1", done: 1, total: 2, plan });
  });

  it("shows a checklist saved in full only as far as the bar until the bar is confirmed", () => {
    const legacy = [
      { text: "What you're after: where you need help with networking", status: "doing" as const, note: "Hardest part: choosing who to contact first" },
      { text: "Your résumé: background for outreach and roles", status: "todo" as const },
      { text: "What success looks like: trial run, then agree your bar", status: "todo" as const },
      { text: "Your search: fill in what I need to search well", status: "todo" as const },
      { text: "Your stories: get interview stories ready", status: "todo" as const },
      { text: "Your apps: connect only what your bar needs", status: "todo" as const },
      { text: "How I'll work: propose the setup for your approval", status: "todo" as const },
    ];
    const shown = summarizeSetup(tenant("owner"), { status: "in_progress", conversationId: "c1", plan: legacy, updatedAt: 1 }, "job-search")!;
    expect(shown.plan.map((s) => s.text)).toEqual(legacy.slice(0, 3).map((s) => s.text));
    expect(shown.plan[0].note).toBe("Hardest part: choosing who to contact first");
    // Once the bar is confirmed, the rest of the checklist shows.
    const confirmed = legacy.map((s, i) => (i <= 2 ? { ...s, status: "done" as const } : s));
    expect(toTheBar(confirmed)).toEqual(confirmed);
    // A trial still to come, or anything already under way, stays on.
    expect(toTheBar([legacy[0], legacy[2], { text: "Trial run on your invoices", status: "todo" }, { text: "Your apps", status: "doing" }]).map((s) => s.text)).toEqual([
      legacy[0].text,
      legacy[2].text,
      "Trial run on your invoices",
      "Your apps",
    ]);
  });

  it("is only for the owner", () => {
    expect(summarizeSetup(tenant("member"), null, "job-search")).toBeNull();
  });
});

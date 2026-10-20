import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { JourneyStep } from "@/lib/types";
import { Journey, JourneyBar, JourneyGoal, JourneyList } from "./journey";

// The rail shows only what it's given: the step under way breathes only while the agent is on it,
// and what done means, cut to one line on the closed rail, can be read in full once it's opened.

const steps: JourneyStep[] = [
  { text: "Search caterers", status: "done", note: "Found 9" },
  { text: "Shortlist", status: "doing" },
  { text: "Draft a quote request", status: "todo" },
];
const GOAL = "three caterers under $40 a head, each happy to do a 60-person launch on a weekday evening, with a quote request ready";

describe("the journey rail", () => {
  it("breathes on the step under way only while the agent is working, or when no one says", () => {
    expect(renderToStaticMarkup(<Journey steps={steps} move="working" />)).toContain("breathe-soft");
    expect(renderToStaticMarkup(<Journey steps={steps} />)).toContain("breathe-soft");
    for (const move of ["your_call", "done", "stuck", "idle"] as const) {
      expect(renderToStaticMarkup(<Journey steps={steps} move={move} />), move).not.toContain("breathe-soft");
    }
    expect(renderToStaticMarkup(<JourneyBar steps={steps} still />)).not.toContain("breathe-soft");
    expect(renderToStaticMarkup(<JourneyList steps={steps} still />)).not.toContain("breathe-soft");
  });

  it("cuts what done means to one line until it's opened, then shows it in full", () => {
    const closed = renderToStaticMarkup(<Journey steps={steps} goal={GOAL} move="idle" onClear={() => undefined} />);
    expect(closed).toContain(`Done means ${GOAL}`);
    expect(closed).toMatch(/class="[^"]*truncate[^"]*"[^>]*>Done means/);
    // Clearing waits in the opened list.
    expect(closed).not.toContain("Clear this plan");
    const open = renderToStaticMarkup(<JourneyGoal goal={GOAL} open />);
    expect(open).toContain(`Done means ${GOAL}`);
    expect(open).not.toContain("truncate");
  });
});

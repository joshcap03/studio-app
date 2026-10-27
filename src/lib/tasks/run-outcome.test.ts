import { describe, expect, it } from "vitest";
import { runOutcome } from "./index";

// Where a task's run is once its reply is saved, which the worker reads to carry it on.

describe("runOutcome", () => {
  it("keeps a run going when its reply ran out of time with more to do, and ends it otherwise", () => {
    expect(runOutcome({ status: "complete", keepGoing: "label the rest" }, { outcome: "update" })).toEqual({ status: "running", reason: "keep_going" });
    expect(runOutcome({ status: "complete" }, { outcome: "update" })).toEqual({ status: "done", reason: "update" });
    expect(runOutcome({ status: "awaiting", keepGoing: "x" })).toEqual({ status: "running", reason: "waiting_on_you" });
    // Cut off by the request's time limit, it carries on too; any other error ends it.
    expect(runOutcome({ status: "error", keepGoing: "x" })).toEqual({ status: "running", reason: "keep_going" });
    expect(runOutcome({ status: "error" })).toEqual({ status: "failed", reason: "error" });
  });
});

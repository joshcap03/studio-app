import { describe, expect, it } from "vitest";
import { disconnectProblem, OUT_OF_MINUTES } from "./disconnect";

describe("disconnectProblem", () => {
  it("says plainly when the provider is out of credits, however it reports it", () => {
    const quota = "[quota_exceeded] You've run out of credits. Add credits or upgrade your plan to start a new conversation.";
    expect(disconnectProblem({ reason: "agent", closeCode: 1002, closeReason: quota })).toBe(OUT_OF_MINUTES);
    expect(disconnectProblem({ reason: "error", message: "This request exceeds your quota limit." })).toBe(OUT_OF_MINUTES);
  });

  it("keeps other errors, and is nothing for a call that just ended", () => {
    expect(disconnectProblem({ reason: "error", message: "The connection closed" })).toBe("The connection closed");
    expect(disconnectProblem({ reason: "user" })).toBeNull();
    expect(disconnectProblem({ reason: "agent", closeCode: 1000, closeReason: "Conversation ended" })).toBeNull();
    expect(disconnectProblem({ reason: "agent" })).toBeNull();
    expect(disconnectProblem(undefined)).toBeNull();
  });
});

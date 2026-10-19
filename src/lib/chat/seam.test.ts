import { describe, expect, it } from "vitest";
import { seamBetween } from "./seam";

describe("seamBetween", () => {
  it("starts a new paragraph for a new thought", () => {
    expect(seamBetween("leave the choosing to you.", "You can keep the name Wren.")).toBe("\n\n");
    expect(seamBetween("Here's what I found:", "1. Acme")).toBe("\n\n");
    expect(seamBetween("Okay to send?", "Sent it to Jo.")).toBe("\n\n");
    expect(seamBetween("Let me check your calendar", "You're free Tuesday.")).toBe("\n\n");
  });

  it("carries on a sentence with a space or nothing", () => {
    expect(seamBetween("Acme lists 40 roles [1]", ", mostly remote.")).toBe("");
    expect(seamBetween("Acme lists 40 roles", "and most are remote.")).toBe(" ");
    expect(seamBetween("Acme lists 40 roles [1]", "and most are remote.")).toBe(" ");
    expect(seamBetween("Acme lists 40 roles (all remote)", "and two are senior.")).toBe(" ");
    expect(seamBetween("the U.S.", "and Canada.")).toBe(" ");
  });

  it("leaves whitespace the agent wrote alone", () => {
    expect(seamBetween("Done.\n", "Next")).toBe("");
    expect(seamBetween("Done.", " Next")).toBe("");
    expect(seamBetween("", "Hi")).toBe("");
    expect(seamBetween("Hi", "")).toBe("");
  });

  it("puts markdown that ends a line on its own line", () => {
    expect(seamBetween("```", "then run it")).toBe("\n\n");
    expect(seamBetween("| a | b |", "that's the table")).toBe("\n\n");
  });

  it("never puts a space inside CJK text, and starts a new paragraph after a full-width stop", () => {
    expect(seamBetween("我找到了三个职位。", "你可以选择。")).toBe("\n\n");
    expect(seamBetween("我找到了", "三个职位。")).toBe("");
    expect(seamBetween("結果です", "次へ")).toBe("");
    expect(seamBetween("هل تريد المتابعة؟", "يمكنني البحث.")).toBe("\n\n");
  });
});

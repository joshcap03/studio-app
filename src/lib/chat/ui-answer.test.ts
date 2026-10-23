import { describe, expect, it } from "vitest";
import { guessFixText } from "./ui-answer";

describe("fixing a proposal's guesses", () => {
  it("sends each wrong guess with what's right, and says the rest stand", () => {
    const guesses = ["I assumed you always want the 5 lb bag.", "I assumed you stop at checkout."];
    expect(guessFixText(guesses, { 0: "  The 2 lb bag, unless it's sold out. " })).toBe(
      [
        "Some of your guesses aren't right:",
        "- You guessed: “I assumed you always want the 5 lb bag.” Actually: The 2 lb bag, unless it's sold out.",
        "",
        "The rest are right.",
        "",
        "Rewrite it with these and propose it again.",
      ].join("\n"),
    );
    expect(guessFixText(guesses, { 0: "No.", 1: "Pay with the saved card." })).not.toContain("The rest are right.");
  });
});

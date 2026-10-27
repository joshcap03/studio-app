import { describe, expect, it } from "vitest";
import { aboutOf } from "./home";
import { templateById } from "./templates";

describe("home", () => {
  it("says what an agent is for from its profile, folded to one line", () => {
    expect(aboutOf("  Runs my bakery.\n\nOrders and   stock. ", "small-business")).toBe("Runs my bakery. Orders and stock.");
  });

  it("falls back to its template's description, then to nothing", () => {
    expect(aboutOf("   ", "small-business")).toBe(templateById("small-business")?.description);
    expect(aboutOf("", null)).toBeNull();
    expect(aboutOf(null, "no-such-template")).toBeNull();
  });
});

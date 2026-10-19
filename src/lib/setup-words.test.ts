import { describe, expect, it } from "vitest";
import { firstName, stepName } from "./setup-words";

describe("setup words", () => {
  it("takes a first name only when it reads like one", () => {
    expect(firstName("josh Caplan")).toBe("Josh");
    expect(firstName("Ana-María López")).toBe("Ana-María");
    expect(firstName("")).toBeNull();
    expect(firstName("joshcaplan05")).toBeNull();
    expect(firstName("@josh")).toBeNull();
  });

  it("names a step for the middle of a sentence", () => {
    expect(stepName("What you're after: understand the search challenges")).toBe("what you're after");
    expect(stepName("Your search — roles and places")).toBe("your search");
    expect(stepName("LinkedIn contacts")).toBe("LinkedIn contacts");
  });
});

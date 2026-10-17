import { describe, expect, it } from "vitest";
import { appForToolkit, toolkitForApp } from "./apps";

describe("apps", () => {
  it("maps prospecting toolkits to apps", () => {
    expect(appForToolkit("APOLLO_PEOPLE_SEARCH")).toBe("apollo");
    expect(appForToolkit("HUNTER_EMAIL_VERIFIER")).toBe("hunter");
    expect(appForToolkit("CLAY_SEARCH_PEOPLE_OR_COMPANIES")).toBe("clay");
    expect(appForToolkit("LINKEDIN_CREATE_LINKED_IN_POST")).toBe("linkedin");
  });

  it("finds the toolkit a member connects for an app", () => {
    expect(toolkitForApp("sheets")).toBe("googlesheets");
    expect(toolkitForApp("apollo")).toBe("apollo");
    expect(toolkitForApp("gmail")).toBe("gmail");
    // Built into the agent, or not an app at all.
    expect(toolkitForApp("web")).toBeUndefined();
    expect(toolkitForApp("browser")).toBeUndefined();
    expect(toolkitForApp("tracker")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { chipSkills } from "./empty-state";

describe("chipSkills", () => {
  it("offers the agent's own skills before the built-ins, five at most", () => {
    const skill = { catalogId: null, name: "x", description: "", instructions: "", createdAt: 0 };
    const own = ["find-roles", "research-company", "tailor-application", "outreach-drafts", "interview-prep"];
    const skills = [{ ...skill, id: "builtin:why" }, ...own.map((id) => ({ ...skill, id }))];
    expect(chipSkills(skills).map((s) => s.id)).toEqual(own);
    expect(chipSkills(skills.slice(0, 3)).map((s) => s.id)).toEqual(["find-roles", "research-company", "builtin:why"]);
  });
});

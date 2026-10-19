import { describe, expect, it } from "vitest";
import type { Memory } from "@/lib/types";
import { BUILTIN_SKILL_IDS } from "./builtin";
import { TIDY_MAX_FACTS, tidyCategory, tidyRequest, tidySkill, tidySkillId } from "./tidy";

const fact = (id: string, extra: Partial<Memory> = {}): Memory => ({
  id,
  content: `Fact ${id}`,
  scope: id.startsWith("workspace:") ? "workspace" : "personal",
  createdAt: 1,
  mine: true,
  category: "suppliers",
  pinned: false,
  ...extra,
});

describe("tidy skill", () => {
  it("has one id per topic, accepted wherever built-in skills are", () => {
    expect(tidyCategory(tidySkillId("voice"))).toBe("voice");
    expect(tidyCategory("builtin:tidy:mystery")).toBeNull();
    expect(BUILTIN_SKILL_IDS).toContain("builtin:tidy:suppliers");
    expect(tidyRequest("suppliers")).toBe("Tidy up what you know about Organizations.");
  });

  it("lists the topic's facts the member may change by id, newest first, shared apart from their own", () => {
    const skill = tidySkill(
      "suppliers",
      [
        fact("workspace:old", { createdAt: 1 }),
        fact("workspace:new", { createdAt: 5, pinned: true }),
        fact("workspace:theirs", { mine: false }),
        fact("personal:mine", { createdAt: 3 }),
        fact("workspace:other-topic", { category: "team" }),
      ],
      { owner: false },
    );
    expect(skill.instructions).toContain("merge_memories");
    expect(skill.instructions).toContain("Topic: Organizations");
    expect(skill.instructions).toMatch(/Shared facts[^\n]*\n- \[workspace:new\] \(pinned\) Fact workspace:new\n- \[workspace:old\] Fact workspace:old\n\nFacts only the member sees:\n- \[personal:mine\] Fact personal:mine/);
    expect(skill.instructions).not.toContain("workspace:theirs");
    expect(skill.instructions).not.toContain("other-topic");
    // An owner may change any shared fact.
    expect(tidySkill("suppliers", [fact("workspace:theirs", { mine: false })], { owner: true }).instructions).toContain("[workspace:theirs]");
  });

  it("reads at most the newest facts of a long topic, and says so", () => {
    const many = Array.from({ length: TIDY_MAX_FACTS + 10 }, (_, i) => fact(`workspace:f${i}`, { createdAt: i }));
    const skill = tidySkill("suppliers", many, { owner: true });
    expect(skill.instructions).toContain(`newest ${TIDY_MAX_FACTS} of ${TIDY_MAX_FACTS + 10}`);
    expect(skill.instructions).not.toContain("[workspace:f0]");
  });

  it("says there's nothing to tidy when the member can change none of the topic", () => {
    expect(tidySkill("team", [fact("workspace:x")], { owner: false }).instructions).toContain("no facts in this topic");
  });
});

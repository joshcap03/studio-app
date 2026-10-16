import { describe, expect, it, vi } from "vitest";
import type { Tenant } from "@/lib/tenant";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ previewEmails: new Set(["preview@example.test"]) }),
}));

const { builtinSkill, builtinSkills } = await import("./builtin");

const tenant = (email: string) => ({ email }) as unknown as Tenant;

describe("built-in skills", () => {
  it("offers Investigate only to accounts with the preview", () => {
    expect(builtinSkills(tenant("preview@example.test")).map((s) => s.id)).toEqual(["builtin:why"]);
    expect(builtinSkills(tenant("someone@example.test"))).toEqual([]);
    expect(builtinSkill(tenant("someone@example.test"), "builtin:why")).toBeNull();
    expect(builtinSkill(tenant("preview@example.test"), "builtin:nope")).toBeNull();
  });

  it("only reads, and reports through report_timeline", () => {
    const why = builtinSkill(tenant("preview@example.test"), "builtin:why")!;
    expect(why.instructions).toMatch(/Never use take_action/);
    expect(why.instructions).toMatch(/report_timeline/);
  });
});

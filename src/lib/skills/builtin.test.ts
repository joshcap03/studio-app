import { describe, expect, it, vi } from "vitest";
import type { Tenant } from "@/lib/tenant-core";

const config: { previewEmails: Set<string>; browser?: { apiKey: string } } = { previewEmails: new Set(["preview@example.test"]) };
vi.mock("@/lib/config", () => ({ getConfig: () => config }));

const { builtinSkill, builtinSkills } = await import("./builtin");

const tenant = (email: string, role: "owner" | "member" = "owner") => ({ email, workspace: { role } }) as unknown as Tenant;

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
    expect(why.instructions).toMatch(/report_visual/);
  });

  it("offers Show me once to owners, only where the agent has a hosted browser", () => {
    expect(builtinSkill(tenant("someone@example.test"), "builtin:teach")).toBeNull();
    config.browser = { apiKey: "bb_test" };
    try {
      expect(builtinSkills(tenant("someone@example.test")).map((s) => s.id)).toEqual(["builtin:teach"]);
      expect(builtinSkill(tenant("someone@example.test", "member"), "builtin:teach")).toBeNull();
      const teach = builtinSkill(tenant("someone@example.test"), "builtin:teach")!;
      // It watches through the generic cards, writes intents rather than clicks, and names its guesses.
      expect(teach.instructions).toMatch(/watch_me/);
      expect(teach.instructions).toMatch(/propose_agent/);
      expect(teach.instructions).toMatch(/assumptions/);
      expect(teach.instructions).toMatch(/not from their clicks/);
      expect(teach.instructions).toMatch(/take_action/);
    } finally {
      delete config.browser;
    }
  });
});

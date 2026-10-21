import { describe, expect, it } from "vitest";
import { createLangflowAdapter, type LangflowConfig } from "@/lib/agent/langflow";
import type { AgentEvent, AgentTenantContext } from "@/lib/agent/types";
import { parseMergeRequest } from "@/lib/memory-merge";
import { renderSkillMessage } from "@/lib/skills/render";
import { tidyRequest, tidySkill } from "@/lib/skills/tidy";
import type { Memory } from "@/lib/types";

// Eval for "Tidy up" against a live flow with a real model (LANGFLOW_TEST_* env): the tidy
// skill lists a topic's facts by id, and the agent must propose merges through merge_memories
// that name only those ids, never mix shared facts with the member's own, keep each fact's
// details, and leave facts that stand alone. Checks read only the structured tool result.
// The facts are made up.

const baseUrl = process.env.LANGFLOW_TEST_BASE_URL;
const apiKey = process.env.LANGFLOW_TEST_API_KEY;
const flowId = process.env.LANGFLOW_TEST_FLOW_ID;
const enabled = Boolean(baseUrl && apiKey && flowId);

const DEFAULT_TWEAKS = {
  "WorkspaceContext-studio": { workspace_context: "{{system_context}}" },
  "MemberApps-studio": { member_id: "{{composio_user_id}}", toolkits: "{{composio_toolkits}}" },
};

let at = 100;
const fact = (id: string, content: string, extra: Partial<Memory> = {}): Memory => ({
  id,
  content,
  scope: id.startsWith("workspace:") ? "workspace" : "personal",
  createdAt: at--,
  mine: true,
  category: "suppliers",
  pinned: false,
  ...extra,
});

const FACTS = [
  fact("workspace:evalTopTier1", "Northwind Capital counts as a top-tier investor."),
  fact("workspace:evalTopTier2", "Blue Harbor Ventures is also top tier.", { pinned: true }),
  fact("workspace:evalTopTier3", "Treat Northwind Capital and Blue Harbor Ventures as the top tier, and skip seed-only funds."),
  fact("workspace:evalPartner", "Our design partner is Lumen Studio, based in Lisbon."),
  fact("workspace:evalPass1", "Any role at a crypto company counts as a pass."),
  fact("workspace:evalPass2", "Crypto roles are a pass, and so are roles at agencies."),
  fact("personal:evalIntro1", "I prefer warm introductions to investors."),
  fact("personal:evalIntro2", "I want intros through warm contacts rather than cold emails."),
  fact("personal:evalCity", "I'm based in Denver."),
];
const byId = new Map(FACTS.map((f) => [f.id, f]));

function tenant(): AgentTenantContext {
  return {
    workspaceId: crypto.randomUUID(),
    workspaceName: "Tidy eval",
    userId: crypto.randomUUID(),
    composioUserId: `eval_${crypto.randomUUID()}`,
    composioToolkits: {},
    profile: "Helping the owner raise a seed round and hire a small team.",
    agentInstructions: "",
    memories: [],
  };
}

describe.skipIf(!enabled)("Tidy up against a live flow", () => {
  const tweaks = process.env.LANGFLOW_TEST_TWEAKS ? (JSON.parse(process.env.LANGFLOW_TEST_TWEAKS) as unknown) : DEFAULT_TWEAKS;
  const config: LangflowConfig = { baseUrl: baseUrl!, apiKey: apiKey!, flowId: flowId!, stream: true, tweaks };

  it("proposes merges of overlapping facts by their ids, keeping every detail", { timeout: 300_000 }, async () => {
    const message = renderSkillMessage(tidySkill("suppliers", FACTS, { owner: true }), tidyRequest("suppliers"));
    const events: AgentEvent[] = [];
    for await (const e of createLangflowAdapter(config).run({
      conversationId: crypto.randomUUID(),
      threadId: null,
      message,
      history: [],
      tenant: tenant(),
      attachments: [],
      signal: AbortSignal.timeout(280_000),
    })) {
      events.push(e);
    }
    const raw = events.find((e): e is Extract<AgentEvent, { type: "ui" }> => e.type === "ui")?.block as { memory_merge?: { merges?: { replaces?: string[] }[] } } | undefined;
    const reply = events
      .filter((e) => e.type === "message" || e.type === "text-delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(raw?.memory_merge, `no merge_memories call; reply: ${reply.slice(-500)}`).toBeDefined();
    // Every id it named was one it was given, exactly.
    for (const m of raw!.memory_merge!.merges ?? []) for (const id of m.replaces ?? []) expect(byId.has(id), `made-up id ${id}`).toBe(true);

    const request = parseMergeRequest(raw)!;
    expect(request, "no usable merge").not.toBeNull();
    const merged = new Set(request.merges.flatMap((m) => m.replaces));
    for (const m of request.merges) {
      const scopes = new Set(m.replaces.map((id) => byId.get(id)!.scope));
      expect(scopes.size, `mixed shared and personal: ${m.replaces.join(", ")}`).toBe(1);
      // The merged text keeps the names and conditions in the facts it replaces.
      const text = m.text.toLowerCase();
      if (m.replaces.some((id) => id.startsWith("workspace:evalTopTier"))) expect(text, m.text).toMatch(/northwind[\s\S]*blue harbor|blue harbor[\s\S]*northwind/);
      if (m.replaces.includes("workspace:evalTopTier3")) expect(text, m.text).toContain("seed");
      if (m.replaces.includes("workspace:evalPass2")) expect(text, m.text).toContain("agenc");
    }
    // The overlapping top-tier facts are combined; facts that stand alone are left.
    expect(request.merges.some((m) => m.replaces.filter((id) => id.startsWith("workspace:evalTopTier")).length >= 2), "top-tier facts not merged").toBe(true);
    expect(merged.has("workspace:evalPartner"), "merged a fact that stands alone").toBe(false);
    expect(merged.has("personal:evalCity"), "merged a fact that stands alone").toBe(false);
  });

  it("folds a fact a newer one cancels into one that says what's true now", { timeout: 300_000 }, async () => {
    // Newest first, as the Brain lists them.
    const facts = [
      fact("workspace:evalCut1", "Auto-print is cut for now: approved label PDFs go to a Google Drive folder and the employee prints them herself.", { category: "policies" }),
      fact("workspace:evalCut2", "Josh cut auto-print from scope for now; getting the label PDF into a synced folder is enough.", { category: "policies" }),
      fact("workspace:evalOld1", "Labels print automatically from a watched folder on the shop Mac, with no one clicking print.", { category: "policies" }),
      fact("workspace:evalBox", "Orders always ship in the same 6x4x1 box at 1 lb, USPS ground.", { category: "policies" }),
    ];
    const message = renderSkillMessage(tidySkill("policies", facts, { owner: true }), tidyRequest("policies"));
    const events: AgentEvent[] = [];
    for await (const e of createLangflowAdapter(config).run({
      conversationId: crypto.randomUUID(),
      threadId: null,
      message,
      history: [],
      tenant: tenant(),
      attachments: [],
      signal: AbortSignal.timeout(280_000),
    })) {
      events.push(e);
    }
    const raw = events.find((e): e is Extract<AgentEvent, { type: "ui" }> => e.type === "ui")?.block;
    const request = parseMergeRequest(raw);
    expect(request, "no usable merge").not.toBeNull();
    const merge = request!.merges.find((m) => m.replaces.includes("workspace:evalOld1"));
    expect(merge, "the cancelled plan wasn't folded in").toBeDefined();
    expect(merge!.replaces).toEqual(expect.arrayContaining(["workspace:evalCut1"]));
    expect(merge!.text.toLowerCase(), merge!.text).toMatch(/drive|synced folder/);
    expect(merge!.text.toLowerCase(), merge!.text).not.toMatch(/watched folder|no one clicking/);
    expect(request!.merges.some((m) => m.replaces.includes("workspace:evalBox")), "merged a fact that stands alone").toBe(false);
  });
});

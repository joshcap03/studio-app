import { describe, expect, it } from "vitest";
import { createLangflowAdapter, type LangflowConfig } from "@/lib/agent/langflow";
import type { AgentEvent, AgentTenantContext } from "@/lib/agent/types";

// Remembering without sprawl, on a live flow with a real model (LANGFLOW_TEST_* env; point it
// at a test flow, never the live one). Given the facts it saved most recently by id, the agent
// updates one when the member changes it (remember with replaces) instead of saving another
// copy, and doesn't save again what one already says. Made-up members and facts only.

const DEFAULT_TWEAKS = {
  "WorkspaceContext-studio": { workspace_context: "{{system_context}}" },
  "MemberApps-studio": { member_id: "{{composio_user_id}}", toolkits: "{{composio_toolkits}}" },
};
const enabled = Boolean(process.env.LANGFLOW_TEST_BASE_URL && process.env.LANGFLOW_TEST_API_KEY && process.env.LANGFLOW_TEST_FLOW_ID);

const recentMemories = [
  { id: "workspace:a1", content: "Labels should print automatically on the shop's thermal printer after the employee approves the purchase." },
  { id: "workspace:a2", content: "Orders always ship in the same 6x4x1 box, 1 lb, with USPS's cheapest ground service." },
  { id: "workspace:a3", content: "Orders arrive only by direct message; nothing is in Shopify." },
];

const tenant = (): AgentTenantContext => ({
  workspaceId: crypto.randomUUID(),
  workspaceName: "Small business",
  userId: crypto.randomUUID(),
  composioUserId: `eval_${crypto.randomUUID()}`,
  account: { name: "Dana Okafor", about: "Runs a two-person ceramics studio." },
  composioToolkits: {},
  profile: "Help Dana run the studio: shipping labels, orders, and wholesale accounts.",
  agentInstructions: "",
  memories: recentMemories.map((m) => m.content),
  recentMemories,
  task: null,
  tracker: [],
  setup: null,
  notes: [],
  agentFiles: [],
  guardrail: null,
  self: { name: null, manner: null },
});

async function run(message: string) {
  const config: LangflowConfig = {
    baseUrl: process.env.LANGFLOW_TEST_BASE_URL!,
    apiKey: process.env.LANGFLOW_TEST_API_KEY!,
    flowId: process.env.LANGFLOW_TEST_FLOW_ID!,
    stream: true,
    tweaks: process.env.LANGFLOW_TEST_TWEAKS ? JSON.parse(process.env.LANGFLOW_TEST_TWEAKS) : DEFAULT_TWEAKS,
  };
  const events: AgentEvent[] = [];
  for await (const e of createLangflowAdapter(config).run({
    conversationId: crypto.randomUUID(),
    threadId: null,
    message,
    history: [],
    tenant: tenant(),
    attachments: [],
    signal: AbortSignal.timeout(180_000),
  })) {
    events.push(e);
  }
  return events.flatMap((e) => (e.type === "memory-proposal" ? [e] : []));
}

describe.skipIf(!enabled)("remember on a live flow", () => {
  it("updates the fact the member changes instead of saving another copy", async () => {
    const saved = await run(
      "Change of plan: forget auto-printing for now. Just save each approved label PDF to our Google Drive folder and she'll print it herself.",
    );
    console.log(JSON.stringify(saved, null, 2));
    expect(saved.length).toBeGreaterThan(0);
    // Every fact about printing takes the old one's place rather than sitting beside it.
    const printing = saved.filter((s) => /print/i.test(s.content));
    expect(printing.length).toBeGreaterThan(0);
    // The app reads an id without its scope as one in the fact's own.
    const names = (s: AgentEvent & { type: "memory-proposal" }) => (s.replaces ?? []).map((id) => id.replace(/^workspace:/, ""));
    expect(printing.every((s) => names(s).includes("a1"))).toBe(true);
    expect(saved.some((s) => names(s).some((id) => id === "a2" || id === "a3"))).toBe(false);
  }, 200_000);

  it("doesn't save again what a fact already says", async () => {
    const saved = await run("Reminder, everything goes out in the 6x4x1 box at 1 lb, cheapest USPS ground. Can you tell me roughly what that costs?");
    console.log(JSON.stringify(saved, null, 2));
    expect(saved.filter((s) => !s.replaces?.length)).toEqual([]);
  }, 200_000);
});

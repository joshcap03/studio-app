import { describe, expect, it } from "vitest";
import { createLangflowAdapter, langflowSessionId, type LangflowConfig } from "@/lib/agent/langflow";
import type { AgentEvent, AgentRunInput, AgentTenantContext } from "@/lib/agent/types";

// Runs the real adapter against a live Langflow server (LANGFLOW_TEST_* env). Verifies the
// wire contract end to end and that Langflow stores each tenant's history under its own
// session. Skipped when no test server is configured.

const baseUrl = process.env.LANGFLOW_TEST_BASE_URL;
const apiKey = process.env.LANGFLOW_TEST_API_KEY;
const flowId = process.env.LANGFLOW_TEST_FLOW_ID;
const enabled = Boolean(baseUrl && apiKey && flowId);

const tenant = (n: string): AgentTenantContext => ({
  workspaceId: crypto.randomUUID(),
  workspaceName: `Tenant ${n}`,
  userId: crypto.randomUUID(),
  composioUserId: `lj_${n}`,
  businessContext: "",
  agentInstructions: "",
  memories: [],
});

async function runOnce(
  config: LangflowConfig,
  t: AgentTenantContext,
  conversationId: string,
  message: string,
  extra: Partial<AgentRunInput> = {},
) {
  const events: AgentEvent[] = [];
  for await (const e of createLangflowAdapter(config).run({
    conversationId,
    threadId: null,
    message,
    history: [],
    tenant: t,
    attachments: [],
    signal: new AbortController().signal,
    ...extra,
  })) {
    events.push(e);
  }
  return events;
}

async function storedMessages(sessionId: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/api/v1/monitor/messages?session_id=${encodeURIComponent(sessionId)}`, {
    headers: { "x-api-key": apiKey! },
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { text: string }[]).map((m) => m.text);
}

describe.skipIf(!enabled)("Langflow adapter against a live server", () => {
  const config = { baseUrl: baseUrl!, apiKey: apiKey!, flowId: flowId!, stream: true };

  it("streams a reply in both streaming and non-streaming modes", async () => {
    const t = tenant("a");
    const streamed = await runOnce(config, t, crypto.randomUUID(), "ping streamed");
    expect(streamed.find((e) => e.type === "message" || e.type === "text-delta")).toBeTruthy();
    const whole = await runOnce({ ...config, stream: false }, t, crypto.randomUUID(), "ping whole");
    expect(whole).toContainEqual({ type: "message", text: "ping whole" });
  });

  it("keeps two tenants' histories in separate Langflow sessions, even for the same conversation id", async () => {
    const a = tenant("alice");
    const b = tenant("bob");
    const sharedConversationId = crypto.randomUUID();
    await runOnce(config, a, sharedConversationId, "alice-only-secret");
    await runOnce(config, b, sharedConversationId, "bob-only-note");

    const aliceSession = await storedMessages(langflowSessionId(a, sharedConversationId));
    const bobSession = await storedMessages(langflowSessionId(b, sharedConversationId));
    expect(aliceSession).toContain("alice-only-secret");
    expect(aliceSession).not.toContain("bob-only-note");
    expect(bobSession).toContain("bob-only-note");
    expect(bobSession).not.toContain("alice-only-secret");
  });

  it("rejects a bad API key with a non-retryable error", async () => {
    await expect(runOnce({ ...config, apiKey: "wrong" }, tenant("x"), crypto.randomUUID(), "hi")).rejects.toMatchObject({
      retryable: false,
    });
  });
});

// A flow built with the Studio Tool Gateway (langflow/components). Uses a real model, so it
// only runs when LANGFLOW_TEST_GATEWAY_FLOW_ID is set. Give it a flow without app connections:
// the test asks for a harmless action (loading a playbook) to go through approval.
const gatewayFlowId = process.env.LANGFLOW_TEST_GATEWAY_FLOW_ID;

describe.skipIf(!(baseUrl && apiKey && gatewayFlowId))("Studio gateway flow against a live server", () => {
  let config: LangflowConfig;

  it("finds the flow's chat input for files", async () => {
    const res = await fetch(`${baseUrl}/api/v1/flows/${gatewayFlowId}`, { headers: { "x-api-key": apiKey! } });
    const flow = (await res.json()) as { data: { nodes: { data: { id: string; type: string } }[] } };
    const chatInput = flow.data.nodes.find((n) => n.data.type === "ChatInput")!.data.id;
    config = { baseUrl: baseUrl!, apiKey: apiKey!, flowId: gatewayFlowId!, stream: true, tweaks: { [chatInput]: { files: "{{files}}" } } };
    expect(createLangflowAdapter(config).capabilities).toMatchObject({ approvals: true, attachments: true, rewind: true });
  });

  it("pauses before an action, continues on a decision, reads files, and rewinds", { timeout: 180_000 }, async () => {
    const t = tenant("gate");
    const conversationId = crypto.randomUUID();
    const file = { id: "f", name: "suppliers.csv", mimeType: "text/csv", size: 40, read: async () => new Blob(["supplier,city\nNorth Mill,Lowell\n"]) };
    const first = await runOnce(
      config,
      t,
      conversationId,
      "Integration test. First tell me the supplier in the attached CSV. Then call take_action with tool_name load_skill, " +
        'arguments {"skill_name": "data-tasks"}, and summary "Load the data-tasks playbook (test)". Then answer in one line.',
      { attachments: [file] },
    );
    const approval = first.find((e) => e.type === "approval");
    expect(approval).toMatchObject({ type: "approval", summary: "Load the data-tasks playbook (test)" });

    const resumed = await runOnce(config, t, conversationId, "", {
      resume: { decision: "reject", state: (approval as Extract<AgentEvent, { type: "approval" }>).state },
    });
    const text = resumed
      .filter((e): e is Extract<AgentEvent, { type: "text-delta" | "message" }> => e.type === "text-delta" || e.type === "message")
      .map((e) => e.text)
      .join("");
    expect(text).toMatch(/North Mill/);

    // The same decision can't be used twice.
    await expect(
      runOnce(config, t, conversationId, "", { resume: { decision: "approve", state: (approval as { state: unknown }).state } }),
    ).rejects.toMatchObject({ code: "expired" });

    const session = langflowSessionId(t, conversationId);
    expect((await storedMessages(session)).length).toBeGreaterThan(0);
    await createLangflowAdapter(config).rewind!({ tenant: t, conversationId, threadId: session }, 1);
    expect(await storedMessages(session)).toEqual([]);
  });
});

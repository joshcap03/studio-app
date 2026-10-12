import { describe, expect, it } from "vitest";
import { createLangflowAdapter, langflowSessionId, type LangflowConfig } from "@/lib/agent/langflow";
import type { AgentEvent, AgentTenantContext } from "@/lib/agent/types";

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

async function runOnce(config: LangflowConfig, t: AgentTenantContext, conversationId: string, message: string) {
  const events: AgentEvent[] = [];
  for await (const e of createLangflowAdapter(config).run({
    conversationId,
    threadId: null,
    message,
    history: [],
    tenant: t,
    signal: new AbortController().signal,
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

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
  composioToolkits: {},
  profile: "",
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

// A flow with the Studio Browser node (langflow/components/studio_browser.py) and a real
// model and Browserbase key, so it only runs when LANGFLOW_TEST_BROWSER_FLOW_ID is set.
// Browserbase's hosted server keeps one browser per MCP connection; a shared node gave every
// tenant the same one. Two conversations browsing at once must get separate browsers.
const browserFlowId = process.env.LANGFLOW_TEST_BROWSER_FLOW_ID;

describe.skipIf(!(baseUrl && apiKey && browserFlowId))("Studio Browser against a live server", () => {
  async function browse(t: AgentTenantContext, url: string) {
    const res = await fetch(`${baseUrl}/api/v1/run/${browserFlowId}?stream=false`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey! },
      body: JSON.stringify({
        input_type: "chat",
        output_type: "chat",
        session_id: langflowSessionId(t, crypto.randomUUID()),
        input_value: `Integration test. Call execute_tool with tool_name "start", then navigate to ${url}. Then reply with one word: done.`,
      }),
    });
    expect(res.ok).toBe(true);
    const raw = await res.text();
    // Results are JSON inside JSON strings, so quotes arrive escaped to varying depths.
    const ids = (pattern: RegExp) => [...new Set([...raw.matchAll(pattern)].map((m) => m[1]))];
    return {
      raw,
      sessions: ids(/success\\*"\s*:\s*true\s*,\s*\\*"data\\*"\s*:\s*\{\s*\\*"sessionId\\*"\s*:\s*\\*"([0-9a-f-]{36})/g),
      pages: ids(/pageId\\*"\s*:\s*\\*"([0-9A-F]{32})/g),
    };
  }

  it("gives two conversations browsing at once their own browsers", { timeout: 400_000 }, async () => {
    const [a, b] = await Promise.all([browse(tenant("alice"), "https://example.com"), browse(tenant("bob"), "https://example.org")]);
    expect(a.sessions).toHaveLength(1);
    expect(b.sessions).toHaveLength(1);
    expect(a.sessions[0]).not.toBe(b.sessions[0]);
    // The pages each run drove, by Chrome page id: never the other run's.
    expect(a.pages.filter((p) => b.pages.includes(p))).toEqual([]);
    // The signed connection URL controls the browser; it never reaches the run's output.
    for (const run of [a, b]) {
      expect(run.raw).not.toMatch(/cdpUrl|signingKey=[^\[]/);
    }
  });
});

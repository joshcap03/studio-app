import { describe, expect, it } from "vitest";
import { buildRequest, createLangflowAdapter, fillTemplate, langflowSessionId, type LangflowConfig } from "./langflow";
import { AgentError, type AgentEvent, type AgentRunInput, type AgentTenantContext } from "./types";

// Wire fixtures follow what Langflow 1.12.5 actually sends (captured from a live server and
// its event manager source): JSON objects separated by a blank line.

const tenantA: AgentTenantContext = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  workspaceName: "Alice Atelier",
  userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  composioUserId: "lj_alice",
  businessContext: "Handmade rings.",
  agentInstructions: "Be brief.",
  memories: ["Fiscal year starts in February"],
};
const tenantB: AgentTenantContext = {
  ...tenantA,
  workspaceId: "22222222-2222-4222-8222-222222222222",
  workspaceName: "Bob Bakery",
  userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  composioUserId: "lj_bob",
  businessContext: "Sourdough.",
  memories: [],
};

const base: LangflowConfig = { baseUrl: "http://langflow.test", apiKey: "lf-key", flowId: "flow-1", stream: true };

function input(tenant: AgentTenantContext, overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    conversationId: "c0ffee00-0000-4000-8000-000000000000",
    threadId: null,
    message: "Hello",
    history: [],
    tenant,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const frame = (event: string, data: unknown) => `${JSON.stringify({ event, data })}\n\n`;

function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

async function run(config: LangflowConfig, response: Response, i = input(tenantA)) {
  const calls: { url: string; init: RequestInit }[] = [];
  const adapter = createLangflowAdapter({
    ...config,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return response;
    }) as unknown as typeof fetch,
  });
  const events: AgentEvent[] = [];
  let error: unknown;
  try {
    for await (const e of adapter.run(i)) events.push(e);
  } catch (e) {
    error = e;
  }
  return { events, error, calls };
}

const user = (text: string) => ({ sender: "User", sender_name: "User", text, session_id: "s", content_blocks: [] });
const bot = (text: string, contents: unknown[] = [], id = "msg-1") => ({
  id,
  sender: "Machine",
  sender_name: "AI",
  text,
  session_id: "s",
  content_blocks: contents.length ? [{ title: "Agent Steps", contents }] : [],
});
const end = (text: string) => ({ result: { session_id: "s", outputs: [{ inputs: {}, outputs: [{ results: { message: bot(text) } }] }] } });

describe("Langflow request", () => {
  it("scopes the session to the workspace and conversation and sends only the caller's ids", () => {
    const { url, init } = buildRequest({ ...base, endUserHeader: "X-End-User" }, input(tenantA));
    expect(url).toBe("http://langflow.test/api/v1/run/flow-1?stream=true");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("lf-key");
    expect(headers["X-LANGFLOW-GLOBAL-VAR-COMPOSIO_USER_ID"]).toBe("lj_alice");
    expect(headers["X-LANGFLOW-GLOBAL-VAR-WORKSPACE_ID"]).toBe(tenantA.workspaceId);
    expect(headers["X-End-User"]).toBe(`${tenantA.workspaceId}.${tenantA.userId}`);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ input_value: "Hello", input_type: "chat", output_type: "chat" });
    expect(body.session_id).toBe(langflowSessionId(tenantA, "c0ffee00-0000-4000-8000-000000000000"));
    expect(JSON.stringify(init)).not.toContain("lj_bob");
  });

  it("gives two tenants different sessions for the same conversation id", () => {
    const a = JSON.parse(buildRequest(base, input(tenantA)).init.body as string).session_id;
    const b = JSON.parse(buildRequest(base, input(tenantB)).init.body as string).session_id;
    expect(a).not.toBe(b);
    expect(a.startsWith(tenantA.workspaceId)).toBe(true);
  });

  it("ignores a stored thread id when choosing the session (it can't be redirected)", () => {
    const body = JSON.parse(buildRequest(base, input(tenantA, { threadId: `${tenantB.workspaceId}.someone-else` })).init.body as string);
    expect(body.session_id.startsWith(tenantA.workspaceId)).toBe(true);
  });

  it("fills the tweaks template with the caller's context", () => {
    const tweaks = { "Agent-x": { system_prompt: "{{system_context}}" }, "Composio-y": { entity_id: "{{composio_user_id}}" } };
    const body = JSON.parse(buildRequest({ ...base, tweaks }, input(tenantA)).init.body as string);
    expect(body.tweaks["Composio-y"].entity_id).toBe("lj_alice");
    expect(body.tweaks["Agent-x"].system_prompt).toContain("Handmade rings.");
    expect(body.tweaks["Agent-x"].system_prompt).toContain("Fiscal year starts in February");
    expect(body.tweaks["Agent-x"].system_prompt).toContain("Be brief.");
    expect(fillTemplate({ k: "{{unknown}}" }, {})).toEqual({ k: "{{unknown}}" });
  });

  it("never puts non-ASCII or multi-line values into headers", () => {
    const { init } = buildRequest(base, input({ ...tenantA, composioUserId: "bad\nvalue" }));
    expect((init.headers as Record<string, string>)["X-LANGFLOW-GLOBAL-VAR-COMPOSIO_USER_ID"]).toBeUndefined();
  });
});

describe("Langflow streaming", () => {
  it("streams tokens and reports the namespaced thread", async () => {
    const { events, error } = await run(
      base,
      streamResponse([
        frame("add_message", user("Hello")),
        frame("add_message", bot("")),
        frame("token", { chunk: "Hi ", id: "msg-1" }),
        frame("token", { chunk: "there", id: "msg-1" }),
        frame("end", end("Hi there")),
      ]),
    );
    expect(error).toBeUndefined();
    expect(events[0]).toEqual({ type: "thread", threadId: langflowSessionId(tenantA, "c0ffee00-0000-4000-8000-000000000000") });
    expect(events.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text)).toEqual(["Hi ", "there"]);
    expect(events.some((e) => e.type === "message")).toBe(false);
  });

  it("uses the bot message when the flow doesn't stream tokens (verified echo-flow shape)", async () => {
    const { events } = await run(base, streamResponse([frame("add_message", user("Hello")), frame("add_message", bot("Hello")), frame("end", end("Hello"))]));
    expect(events.filter((e) => e.type === "message")).toEqual([{ type: "message", text: "Hello" }]);
  });

  it("handles frames split across chunks", async () => {
    const all = frame("add_message", bot("Split answer")) + frame("end", end("Split answer"));
    const { events } = await run(base, streamResponse([all.slice(0, 17), all.slice(17, 60), all.slice(60)]));
    expect(events).toContainEqual({ type: "message", text: "Split answer" });
  });

  it("turns tool calls into running → done activity, and structured outputs into artifacts", async () => {
    const running = { type: "tool_use", name: "GOOGLESHEETS_CREATE", tool_input: { title: "Q3" }, output: null, error: null };
    const done = {
      ...running,
      output: { artifact: { id: "sheet-1", kind: "spreadsheet", title: "Q3", url: "https://docs.google.com/spreadsheets/d/x" } },
    };
    const { events } = await run(
      base,
      streamResponse([frame("add_message", bot("", [running])), frame("add_message", bot("", [done])), frame("token", { chunk: "Done." }), frame("end", end("Done."))]),
    );
    const activity = events.filter((e) => e.type === "activity");
    expect(activity[0]).toMatchObject({ id: "msg-1:0", status: "running", label: "Creating a spreadsheet", app: "sheets" });
    expect(activity[1]).toMatchObject({ id: "msg-1:0", status: "done", label: "Created a spreadsheet", app: "sheets" });
    expect(events.filter((e) => e.type === "artifact")).toHaveLength(1);
  });

  it("shows gateway-wrapped tools as one plain-language step with a receipt (recorded shape)", async () => {
    const wrapper = { type: "tool_use", name: "execute_tool", tool_input: { tool_name: "search", arguments: { query: "casting houses nyc" } }, output: null, error: null };
    const inner = { type: "tool_use", name: "search", tool_input: { query: "casting houses nyc" }, output: null, error: null };
    const doneWrapper = { ...wrapper, output: { type: "tool", tool_call_id: "c1", content: "Title: Acme Casting\nURL: https://acme.example/" } };
    const doneInner = { ...inner, output: { results: [{ url: "https://acme.example/", title: "Acme Casting" }] } };
    const { events } = await run(
      base,
      streamResponse([
        frame("add_message", bot("", [{ type: "tool_use", name: "discover_tools", tool_input: { query: "search" }, output: {}, error: null }, wrapper])),
        frame("add_message", bot("", [{ type: "tool_use", name: "discover_tools", tool_input: { query: "search" }, output: {}, error: null }, wrapper, inner])),
        frame("add_message", bot("", [{ type: "tool_use", name: "discover_tools", tool_input: { query: "search" }, output: {}, error: null }, doneWrapper, doneInner])),
        frame("token", { chunk: "Found one." }),
        frame("end", end("Found one.")),
      ]),
    );
    const steps = events.filter((e) => e.type === "activity") as Extract<AgentEvent, { type: "activity" }>[];
    const visible = steps.filter((e) => !e.hidden);
    expect(new Set(visible.map((e) => e.id))).toEqual(new Set(["msg-1:1"]));
    expect(visible[0]).toMatchObject({ status: "running", label: "Searching the web for “casting houses nyc”", app: "web" });
    expect(visible.at(-1)).toMatchObject({
      status: "done",
      label: "Searched the web for “casting houses nyc”",
      preview: { type: "sources", items: [{ title: "Acme Casting", url: "https://acme.example/", domain: "acme.example" }] },
    });
    expect(steps.find((e) => e.id === "msg-1:0")).toMatchObject({ hidden: true });
  });

  it("reports a failed tool call", async () => {
    const failed = { type: "tool_use", name: "gmail_send", tool_input: {}, output: null, error: "Rate limited" };
    const { events } = await run(base, streamResponse([frame("add_message", bot("", [failed])), frame("end", end("Sorry."))]));
    expect(events.find((e) => e.type === "activity")).toMatchObject({ status: "failed", detail: "Rate limited", app: "gmail" });
  });

  it("does not invent artifacts from text or unstructured tool output", async () => {
    const tool = { type: "tool_use", name: "search", output: "See https://docs.google.com/spreadsheets/d/abc", error: null };
    const { events } = await run(base, streamResponse([frame("add_message", bot("Made https://docs.google.com/x", [tool])), frame("end", end("x"))]));
    expect(events.some((e) => e.type === "artifact")).toBe(false);
  });

  it("surfaces an in-stream error event as an AgentError", async () => {
    const { error } = await run(base, streamResponse([frame("add_message", user("x")), frame("error", { error: "Model quota exceeded" })]));
    expect(error).toBeInstanceOf(AgentError);
    expect((error as Error).message).toContain("Model quota exceeded");
  });

  it("maps HTTP failures to safe, specific errors", async () => {
    for (const [status, pattern, retryable] of [
      [403, /credentials/, false],
      [404, /flow wasn't found/, false],
      [500, /had a problem/, true],
    ] as const) {
      const { error } = await run(base, new Response("{}", { status }));
      expect(error).toBeInstanceOf(AgentError);
      expect((error as AgentError).message).toMatch(pattern);
      expect((error as AgentError).retryable).toBe(retryable);
    }
  });
});

describe("Langflow non-streaming", () => {
  it("reads the reply from the run result", async () => {
    const body = { session_id: "s", outputs: [{ inputs: {}, outputs: [{ results: { message: bot("Whole reply") } }] }] };
    const { events } = await run(
      { ...base, stream: false },
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
    );
    expect(events).toContainEqual({ type: "message", text: "Whole reply" });
  });
});

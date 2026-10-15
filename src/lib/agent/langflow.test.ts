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
  composioToolkits: {},
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
    attachments: [],
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

const JOB = "4b7c0d1e-0000-4000-8000-000000000001";

/**
 * Runs the adapter against a fake Langflow: starting a run returns a job, reading the job's
 * events returns `response`. A non-stream `response` is what starting the run returns.
 */
async function run(config: LangflowConfig, response: Response, i = input(tenantA), routes: Record<string, () => Response> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const isStream = response.headers.get("content-type")?.includes("event-stream");
  const adapter = createLangflowAdapter({
    ...config,
    fetch: (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      for (const [suffix, make] of Object.entries(routes)) if (url.includes(suffix)) return make();
      if (url.endsWith("/api/v2/workflows")) return isStream ? Response.json({ job_id: JOB, status: "queued" }) : response;
      if (url.endsWith(`/api/v2/workflows/${JOB}/events`)) return response;
      return Response.json({});
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
    expect(url).toBe("http://langflow.test/api/v2/workflows");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("lf-key");
    expect(headers["X-LANGFLOW-GLOBAL-VAR-COMPOSIO_USER_ID"]).toBe("lj_alice");
    expect(headers["X-LANGFLOW-GLOBAL-VAR-WORKSPACE_ID"]).toBe(tenantA.workspaceId);
    expect(headers["X-End-User"]).toBe(`${tenantA.workspaceId}.${tenantA.userId}`);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ flow_id: "flow-1", input_value: "Hello", mode: "background", stream_protocol: "langflow" });
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
    expect(body.session_id.split(".")[1]).toBe(tenantA.composioUserId);
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

  it("gives the Member Apps node this member's id and the offered apps, nobody else's", () => {
    const tweaks = { "MemberApps-studio": { member_id: "{{composio_user_id}}", toolkits: "{{composio_toolkits}}" } };
    const tenant = { ...tenantA, composioToolkits: { gmail: "ac_gmail" } };
    const body = JSON.parse(buildRequest({ ...base, tweaks }, input(tenant)).init.body as string);
    expect(body.tweaks["MemberApps-studio"].member_id).toBe("lj_alice");
    expect(JSON.parse(body.tweaks["MemberApps-studio"].toolkits)).toEqual({ gmail: "ac_gmail" });
    const other = JSON.parse(buildRequest({ ...base, tweaks }, input(tenantB)).init.body as string);
    expect(other.tweaks["MemberApps-studio"].member_id).toBe(tenantB.composioUserId);
  });

  it("puts uploaded files where the template says, and leaves the field out when there are none", () => {
    const tweaks = { "ChatInput-1": { files: "{{files}}" } };
    expect(fillTemplate(tweaks, {}, ["u/a.csv"])).toEqual({ "ChatInput-1": { files: ["u/a.csv"] } });
    expect(fillTemplate(tweaks, {}, [])).toEqual({ "ChatInput-1": {} });
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
    // Short text is held until it's clear it isn't an opening line, then released whole.
    expect(events.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text).join("")).toBe("Hi there");
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

  it("treats a line before a tool call as a note, and keeps it out of the answer (recorded shape)", async () => {
    const intro = "I'll look up the hours for this week.";
    const answer = "It's **closed only on Wednesday** this week.";
    const search = { type: "tool_use", name: "search", tool_input: { query: "museum hours" }, output: { results: [{ url: "https://museum.example/", title: "Hours" }] }, error: null };
    const textLeaf = (text: string) => ({ type: "text", text });
    const { events } = await run(
      base,
      streamResponse([
        frame("add_message", user("hours?")),
        frame("add_message", bot("")),
        frame("token", { chunk: "I'll look up the " }),
        frame("token", { chunk: "hours for this week." }),
        frame("add_message", bot(intro)),
        frame("add_message", bot(intro, [textLeaf(intro), search])),
        frame("token", { chunk: "It's **closed only on Wednesday** " }),
        frame("token", { chunk: "this week." }),
        frame("add_message", bot(intro + answer, [textLeaf(intro), search, textLeaf(answer), textLeaf(intro + answer)])),
        frame("end", end(intro + answer)),
      ]),
    );
    expect(events.filter((e) => e.type === "note")).toEqual([{ type: "note", text: intro }]);
    const text = events
      .filter((e): e is Extract<AgentEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe(answer);
    expect(events.some((e) => e.type === "message")).toBe(false);
  });

  it("streams long answers token by token", async () => {
    const long = "word ".repeat(80);
    const { events } = await run(base, streamResponse([frame("token", { chunk: long }), frame("token", { chunk: "more" }), frame("end", end(long + "more"))]));
    expect(events.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text)).toEqual([long, "more"]);
  });

  it("releases short text as the answer when no tool follows", async () => {
    const { events } = await run(base, streamResponse([frame("token", { chunk: "Hey! " }), frame("token", { chunk: "Happy to help." }), frame("end", end("Hey! Happy to help."))]));
    expect(events.filter((e) => e.type === "note")).toEqual([]);
    expect(events.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text).join("")).toBe("Hey! Happy to help.");
  });

  it("strips opening lines from an answer that isn't streamed", async () => {
    const intro = "Let me check.";
    const message = bot(intro + "All clear.", [{ type: "text", text: intro }, { type: "tool_use", name: "search", tool_input: {}, output: { results: [] }, error: null }]);
    const { events } = await run({ ...base, stream: false }, streamResponse([frame("add_message", message), frame("end", { build_duration: 1 })]));
    expect(events).toContainEqual({ type: "message", text: "All clear." });
  });

  it("reports a failed tool call", async () => {
    const failed = { type: "tool_use", name: "gmail_send", tool_input: {}, output: null, error: "Rate limited" };
    const { events } = await run(base, streamResponse([frame("add_message", bot("", [failed])), frame("end", end("Sorry."))]));
    expect(events.find((e) => e.type === "activity")).toMatchObject({ status: "failed", detail: "The app is rate-limiting requests right now.", app: "gmail" });
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

  it("explains model-provider failures in plain words", async () => {
    const { error } = await run(base, streamResponse([frame("error", { error: "APIStatusError: Error code: 402 - in_flight_budget_exhausted" })]));
    expect((error as Error).message).toMatch(/out of credit/);
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

  it("reads steps and opening lines while a background job runs (recorded flat-block shape)", async () => {
    // Mid-run, Langflow 1.12.4 background jobs send the entries themselves as content blocks;
    // only the final message nests them in an "Agent Steps" block.
    const intro = "Let me find where your gold inventory is tracked.";
    const answer = "You have **16 gold pieces in stock**.";
    const discover = { type: "tool_use", name: "discover_tools", tool_input: { query: "inventory" }, output: { content: "[]" }, error: null };
    const read = {
      type: "tool_use",
      name: "execute_tool",
      tool_input: { tool_name: "search", arguments: { query: "gold inventory" } },
      output: null,
      error: null,
    };
    const flat = (text: string, blocks: unknown[]) => ({ ...bot(text), content_blocks: blocks });
    const { events } = await run(
      base,
      streamResponse([
        frame("add_message", flat("", [])),
        frame("token", { chunk: intro }),
        frame("add_message", flat(intro, [{ type: "text", text: intro }])),
        frame("add_message", flat(intro, [{ type: "text", text: intro }, discover, read])),
        frame("token", { chunk: answer }),
        frame("add_message", bot(intro + answer, [{ type: "text", text: intro }, discover, { ...read, output: { content: "ok" } }, { type: "text", text: answer }])),
        frame("end", {}),
      ]),
    );
    expect(events.filter((e) => e.type === "note")).toEqual([{ type: "note", text: intro }]);
    const text = events
      .filter((e): e is Extract<AgentEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe(answer);
    // The step shows while it runs, then updates in place.
    const steps = events.filter((e) => e.type === "activity" && !e.hidden) as Extract<AgentEvent, { type: "activity" }>[];
    expect(steps[0]).toMatchObject({ id: "msg-1:1", status: "running" });
    expect(steps.at(-1)).toMatchObject({ id: "msg-1:1", status: "done" });
  });

  it("reads server-sent frames with data: and id: lines (recorded v2 shape)", async () => {
    const sse = (id: number, event: string, data: unknown) => `data: ${JSON.stringify({ event, data })}\nid: ${id}\n\n`;
    const { events, error } = await run(
      base,
      streamResponse([sse(1, "vertices_sorted", { ids: [] }), sse(2, "add_message", bot("Ready.")), sse(3, "end", { build_duration: 1 })]),
    );
    expect(error).toBeUndefined();
    expect(events).toContainEqual({ type: "message", text: "Ready." });
  });
});

// The pause Langflow sends when the Agent's approval middleware stops before take_action
// (recorded from Langflow 1.12.4 with the Studio Tool Gateway).
const approvalRequest = (requestId = "Agent-1:job:nonce") => ({
  request_id: requestId,
  kind: "tool_approval",
  prompt: "Tool execution requires approval\n\nTool: take_action\nArgs: {...}",
  options: [
    { action_id: "approve", label: "Approve" },
    { action_id: "reject", label: "Reject" },
  ],
  allowed_decisions: ["approve", "reject"],
  action_requests: [
    {
      name: "take_action",
      args: {
        tool_name: "composio_multi_execute_tool",
        arguments: {
          tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "jo@acme.example", subject: "March invoice", api_key: "sk-live-abcdefghijklmnopqrstuvwx" } }],
        },
        summary: "Email Jo the March invoice",
      },
      description: "Tool execution requires approval",
    },
  ],
});

describe("Langflow approvals", () => {
  const sse = (id: number, event: string, data: unknown) => `data: ${JSON.stringify({ event, data })}\nid: ${id}\n\n`;

  it("pauses with the agent's summary, the app, and readable details; secrets stay masked", async () => {
    const { events, error } = await run(
      base,
      streamResponse([sse(1, "add_message", user("Email Jo")), sse(2, "add_message", bot("")), sse(3, "remove_message", { id: "msg-1" }), sse(4, "human_input_required", approvalRequest())]),
    );
    expect(error).toBeUndefined();
    const approval = events.find((e) => e.type === "approval") as Extract<AgentEvent, { type: "approval" }>;
    expect(approval).toMatchObject({ summary: "Email Jo the March invoice", app: "gmail" });
    expect(approval.details).toContainEqual(["Recipient email", "jo@acme.example"]);
    expect(approval.details).toContainEqual(["Subject", "March invoice"]);
    expect(JSON.stringify(approval.details)).not.toContain("abcdefghijklmnop");
    expect(approval.state).toEqual({ jobId: JOB, requestId: "Agent-1:job:nonce", lastEventId: "4" });
    expect(events.at(-1)?.type).toBe("approval");
  });

  it("continues a paused job with the decision and reads on from the last event", async () => {
    const state = { jobId: JOB, requestId: "Agent-1:job:nonce", lastEventId: "12" };
    const { events, calls, error } = await run(
      base,
      streamResponse([sse(13, "token", { chunk: "Sent it to Jo and filed the thread under Invoices." }), sse(14, "end", { build_duration: 1 })]),
      input(tenantA, { resume: { decision: "approve", state } }),
      { [`/workflows/${JOB}/resume`]: () => Response.json({ job_id: JOB, status: "resuming" }) },
    );
    expect(error).toBeUndefined();
    const resume = calls.find((c) => c.url.endsWith(`/api/v2/workflows/${JOB}/resume`));
    expect(JSON.parse(resume!.init.body as string)).toEqual({ request_id: "Agent-1:job:nonce", decision: { action_id: "approve" } });
    expect(calls.some((c) => c.url.endsWith("/api/v2/workflows"))).toBe(false);
    const read = calls.find((c) => c.url.endsWith("/events"));
    expect((read!.init.headers as Record<string, string>)["Last-Event-ID"]).toBe("12");
    expect(events.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text).join("")).toContain("Sent it to Jo");
  });

  describe("the step a run paused on", () => {
    // Recorded shape: the paused message holds hidden discovery calls, then take_action with no
    // output. The resumed job reports the approved call again in a new bot message.
    const discover = { type: "tool_use", name: "discover_tools", tool_input: { query: "gmail" }, output: { content: "[]" }, error: null };
    const connect = { tool_name: "composio_manage_connections", arguments: { toolkits: ["gmail"] }, summary: "Connect Gmail" };
    const pausedCall = { type: "tool_use", name: "take_action", tool_input: connect, output: null, error: null };
    // While it streams, Langflow reports the paused call under the other gateway name.
    const streamedCall = { ...pausedCall, name: "execute_tool" };
    const link = { type: "tool", tool_call_id: "c", content: JSON.stringify({ successful: true, data: { results: { gmail: { redirect_url: "https://connect.composio.dev/link/g1" } } } }) };
    const approvedCall = { ...pausedCall, output: "ok" };
    const innerCall = { type: "tool_use", name: "composio_manage_connections", tool_input: { toolkits: ["gmail"] }, output: link, error: null };
    const connectRequest = { ...approvalRequest(), action_requests: [{ name: "take_action", args: connect }] };
    const steps = (events: AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: "activity" }> => e.type === "activity");

    it("remembers which step the run paused on", async () => {
      const { events } = await run(
        base,
        streamResponse([sse(1, "add_message", bot("", [discover, discover, streamedCall], "msg-1")), sse(2, "human_input_required", connectRequest)]),
      );
      expect(steps(events).at(-1)).toMatchObject({ id: "msg-1:2", status: "running" });
      const approval = events.find((e) => e.type === "approval") as Extract<AgentEvent, { type: "approval" }>;
      expect(approval.state).toEqual({ jobId: JOB, requestId: "Agent-1:job:nonce", lastEventId: "2", step: { id: "msg-1:2", messageKey: "msg-1", tool: "composio_manage_connections" } });
    });

    it("has no step to settle when the paused call wasn't reported before the pause", async () => {
      const status = { type: "tool_use", name: "take_action", tool_input: connect, output: "ok", error: null };
      const { events } = await run(base, streamResponse([sse(1, "add_message", bot("", [discover, status], "msg-1")), sse(2, "human_input_required", connectRequest)]));
      const approval = events.find((e) => e.type === "approval") as Extract<AgentEvent, { type: "approval" }>;
      expect((approval.state as { step?: unknown }).step).toBeUndefined();
    });

    it("settles that step with the resumed call instead of adding another", async () => {
      const state = { jobId: JOB, requestId: "r", lastEventId: "2", step: { id: "msg-1:2", messageKey: "msg-1", tool: "composio_manage_connections" } };
      const search = { type: "tool_use", name: "search", tool_input: { query: "q" }, output: { results: [] }, error: null };
      const { events, error } = await run(
        base,
        streamResponse([
          sse(3, "add_message", bot("", [pausedCall], "msg-2")),
          sse(4, "add_message", bot("", [approvedCall, innerCall], "msg-2")),
          sse(5, "add_message", bot("Here's the link.", [approvedCall, innerCall, search], "msg-2")),
          sse(6, "end", end("Here's the link.")),
        ]),
        input(tenantA, { resume: { decision: "approve", state } }),
        { "/resume": () => Response.json({ status: "resuming" }) },
      );
      expect(error).toBeUndefined();
      const ids = new Set(steps(events).map((s) => s.id));
      expect([...ids]).toEqual(["msg-1:2", "msg-2:2"]);
      expect(steps(events).filter((s) => s.id === "msg-1:2").at(-1)).toMatchObject({ status: "done" });
    });

    it("settles it as failed when the resumed call fails", async () => {
      const state = { jobId: JOB, requestId: "r", lastEventId: "2", step: { id: "msg-1:2", messageKey: "msg-1", tool: "composio_manage_connections" } };
      const failed = { ...pausedCall, output: "Tool composio_manage_connections failed: 503 Service Unavailable" };
      const { events } = await run(
        base,
        streamResponse([sse(3, "add_message", bot("Couldn't connect.", [failed], "msg-2")), sse(4, "end", end("Couldn't connect."))]),
        input(tenantA, { resume: { decision: "approve", state } }),
        { "/resume": () => Response.json({ status: "resuming" }) },
      );
      expect(steps(events).map((s) => s.id)).toEqual(["msg-1:2"]);
      expect(steps(events)[0]).toMatchObject({ status: "failed" });
    });

    it("leaves step ids alone when the resumed job continues the same message", async () => {
      const state = { jobId: JOB, requestId: "r", lastEventId: "2", step: { id: "msg-1:2", messageKey: "msg-1", tool: "composio_manage_connections" } };
      const { events } = await run(
        base,
        streamResponse([sse(3, "add_message", bot("Done.", [discover, discover, approvedCall, innerCall], "msg-1")), sse(4, "end", end("Done."))]),
        input(tenantA, { resume: { decision: "approve", state } }),
        { "/resume": () => Response.json({ status: "resuming" }) },
      );
      expect([...new Set(steps(events).map((s) => s.id))]).toEqual(["msg-1:0", "msg-1:1", "msg-1:2"]);
      expect(steps(events).at(-1)).toMatchObject({ id: "msg-1:2", status: "done" });
    });

    it("points a second pause at its own call, not the one already settled", async () => {
      const state = { jobId: JOB, requestId: "r", lastEventId: "2", step: { id: "msg-1:2", messageKey: "msg-1", tool: "composio_manage_connections" } };
      const next = { ...pausedCall, tool_input: { ...connect, arguments: { toolkits: ["googlesheets"] } } };
      const { events } = await run(
        base,
        streamResponse([sse(3, "add_message", bot("", [approvedCall, innerCall, next], "msg-2")), sse(4, "human_input_required", connectRequest)]),
        input(tenantA, { resume: { decision: "approve", state } }),
        { "/resume": () => Response.json({ status: "resuming" }) },
      );
      const approval = events.find((e) => e.type === "approval") as Extract<AgentEvent, { type: "approval" }>;
      expect((approval.state as { step: unknown }).step).toEqual({ id: "msg-2:2", messageKey: "msg-2", tool: "composio_manage_connections" });
    });
  });

  it("tells the agent a decline was the owner's choice", async () => {
    const state = { jobId: JOB, requestId: "r", lastEventId: null };
    const { calls } = await run(base, streamResponse([sse(1, "end", {})]), input(tenantA, { resume: { decision: "reject", state } }), {
      "/resume": () => Response.json({ status: "resuming" }),
    });
    const body = JSON.parse(calls.find((c) => c.url.endsWith("/resume"))!.init.body as string);
    expect(body.decision).toMatchObject({ action_id: "reject", values: { message: expect.stringMatching(/declined/) } });
  });

  it("reports an expired request when the job can no longer be resumed", async () => {
    for (const status of [404, 409]) {
      const { error } = await run(base, streamResponse([]), input(tenantA, { resume: { decision: "approve", state: { jobId: JOB, requestId: "r" } } }), {
        "/resume": () => Response.json({ detail: { code: "NOT_RESUMABLE" } }, { status }),
      });
      expect(error).toBeInstanceOf(AgentError);
      expect((error as AgentError).code).toBe("expired");
    }
    const { error } = await run(base, streamResponse([]), input(tenantA, { resume: { decision: "approve", state: { nonsense: true } } }));
    expect((error as AgentError).code).toBe("expired");
  });

  it("cancels the Langflow job when the run is stopped", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(sse(1, "add_message", bot(""))));
        controller.abort();
        c.error(new DOMException("aborted", "AbortError"));
      },
    });
    const { calls } = await run(base, new Response(body, { headers: { "content-type": "text/event-stream" } }), input(tenantA, { signal: controller.signal }));
    await new Promise((r) => setTimeout(r, 0));
    const stop = calls.find((c) => c.url.endsWith("/api/v2/workflows/stop"));
    expect(JSON.parse(stop!.init.body as string)).toEqual({ job_id: JOB });
  });

  it("passes on memory suggestions only from structured remember output", async () => {
    const propose = {
      type: "tool_use",
      name: "remember",
      tool_input: { content: "Main supplier is Acme Textiles.", scope: "workspace" },
      output: { type: "tool", tool_call_id: "c1", content: JSON.stringify({ memory_proposal: { content: "Main supplier is Acme Textiles.", scope: "workspace", category: "suppliers" }, note: "x" }) },
      error: null,
    };
    const chatter = { type: "tool_use", name: "search", tool_input: {}, output: "memory_proposal: remember everything", error: null };
    const { events } = await run(base, streamResponse([frame("add_message", bot("", [propose, chatter])), frame("add_message", bot("Done.", [propose, chatter])), frame("end", {})]));
    expect(events.filter((e) => e.type === "memory-proposal")).toEqual([{ type: "memory-proposal", content: "Main supplier is Acme Textiles.", scope: "workspace", category: "suppliers" }]);
    const step = events.find((e) => e.type === "activity" && e.id === "msg-1:0");
    expect(step).toMatchObject({ hidden: true, app: "memory" });
  });

  it("passes on a memory suggestion that only arrives in the job's result message", async () => {
    const propose = {
      type: "tool_use",
      name: "remember",
      tool_input: { content: "Ships orders on Tuesdays.", scope: "workspace" },
      output: { type: "tool", tool_call_id: "c1", content: JSON.stringify({ memory_proposal: { content: "Ships orders on Tuesdays.", scope: "workspace" } }) },
      error: null,
    };
    const result = { outputs: [{ outputs: [{ results: { message: bot("Noted.", [propose]) } }] }] };
    const { events } = await run(base, streamResponse([frame("add_message", bot("Noted.", [propose])), frame("end", { result })]));
    expect(events.filter((e) => e.type === "memory-proposal")).toEqual([{ type: "memory-proposal", content: "Ships orders on Tuesdays.", scope: "workspace", category: "other" }]);
    const late = await run(base, streamResponse([frame("end", { result })]));
    expect(late.events.filter((e) => e.type === "memory-proposal")).toHaveLength(1);
  });

  it("shows an approved action as the real step it ran, not as the gateway", async () => {
    const take = { type: "tool_use", name: "take_action", tool_input: { tool_name: "load_skill", arguments: { skill_name: "data-tasks" }, summary: "Load it" }, output: { type: "tool", tool_call_id: "c", content: "{}" }, error: null };
    const inner = { type: "tool_use", name: "load_skill", tool_input: { skill_name: "data-tasks" }, output: { value: {} }, error: null };
    const { events } = await run(base, streamResponse([frame("add_message", bot("ok", [take, inner])), frame("end", {})]));
    const steps = events.filter((e) => e.type === "activity") as Extract<AgentEvent, { type: "activity" }>[];
    expect(new Set(steps.map((s) => s.id))).toEqual(new Set(["msg-1:0"]));
    expect(steps[0]).toMatchObject({ label: "Checked a playbook" });
  });
});

describe("Langflow attachments", () => {
  const file = { id: "a1", name: "Q3 orders.csv", mimeType: "text/csv", size: 12, read: async () => new Blob(["sku,qty\nA,1"]) };
  const withFiles = { ...base, tweaks: { "ChatInput-1": { files: "{{files}}" } } };

  it("uploads each file under a random name and hands Langflow the paths", async () => {
    const uploaded: string[] = [];
    const { calls, error } = await run(withFiles, streamResponse([frame("add_message", bot("Read it.")), frame("end", {})]), input(tenantA, { attachments: [file] }), {
      "/api/v2/files": () => {
        uploaded.push("x");
        return Response.json({ path: "user-1/9f-Q3_orders.csv" });
      },
    });
    expect(error).toBeUndefined();
    const upload = calls.find((c) => c.url.endsWith("/api/v2/files"))!;
    const form = upload.init.body as FormData;
    const sent = form.get("file") as File;
    expect(sent.name).toMatch(/^[0-9a-f-]{36}-Q3_orders\.csv$/);
    expect(await sent.text()).toBe("sku,qty\nA,1");
    const start = JSON.parse(calls.find((c) => c.url.endsWith("/api/v2/workflows"))!.init.body as string);
    expect(start.tweaks).toEqual({ "ChatInput-1": { files: ["user-1/9f-Q3_orders.csv"] } });
    expect(uploaded).toHaveLength(1);
  });

  it("says files aren't supported when the flow has no place for them", async () => {
    const adapter = createLangflowAdapter(base);
    expect(adapter.capabilities.attachments).toBe(false);
    const { error, calls } = await run(base, streamResponse([]), input(tenantA, { attachments: [file] }));
    expect((error as Error).message).toMatch(/can't read attached files/);
    expect(calls).toHaveLength(0);
    expect(createLangflowAdapter(withFiles).capabilities.attachments).toBe(true);
  });
});

describe("Langflow rewind", () => {
  it("drops the latest exchange from the session's stored memory", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const adapter = createLangflowAdapter({
      ...base,
      fetch: (async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        if (!init.method || init.method === "GET") {
          return Response.json([
            { id: "u1", sender: "User" },
            { id: "b1", sender: "Machine" },
            { id: "u2", sender: "User" },
            { id: "card", sender: "Machine" },
            { id: "b2", sender: "Machine" },
          ]);
        }
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });
    await adapter.rewind!({ tenant: tenantA, conversationId: "c0ffee00-0000-4000-8000-000000000000", threadId: null }, 1);
    const list = new URL(calls[0].url);
    expect(list.pathname).toBe("/api/v1/monitor/messages");
    expect(list.searchParams.get("session_id")).toBe(langflowSessionId(tenantA, "c0ffee00-0000-4000-8000-000000000000"));
    expect(list.searchParams.get("flow_id")).toBe("flow-1");
    expect(calls[1].init.method).toBe("DELETE");
    expect(JSON.parse(calls[1].init.body as string)).toEqual(["u2", "card", "b2"]);
  });

  it("doesn't claim rewind when Langflow scopes memory by end user", () => {
    expect(createLangflowAdapter({ ...base, endUserHeader: "X-End-User" }).capabilities.rewind).toBe(false);
  });
});


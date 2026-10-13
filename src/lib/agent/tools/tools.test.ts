import { describe, expect, it } from "vitest";
import { interpretCalls, type ToolCall } from "./index";
import { maskSecrets, safeUrl } from "./sanitize";

// Fixtures are synthetic but shaped exactly like events captured from a live Langflow agent
// (Tool Gateway + Composio MCP + Exa + Supermemory + Browserbase). No real data.

/** LangChain ToolMessage wrapping an MCP text content array, as the gateway returns it. */
const toolMessage = (payload: unknown) => ({
  type: "tool",
  tool_call_id: "call_1",
  name: "x",
  artifact: null,
  content: [{ type: "text", text: JSON.stringify(payload), annotations: null, meta: null }],
});

const gateway = (tool_name: string, args: Record<string, unknown>, output: unknown = "ok"): ToolCall => ({
  name: "execute_tool",
  input: { tool_name, arguments: args },
  output,
  error: null,
});

describe("interpretCalls", () => {
  it("merges a gateway call with the tool it invoked into one step", () => {
    const steps = interpretCalls([
      gateway("search", { query: "fine jewelry trends" }, "Title: A\nURL: https://a.example/x"),
      {
        name: "search",
        input: { query: "fine jewelry trends" },
        output: { results: [{ url: "https://a.example/x", title: "Trend report" }, { url: "https://b.example/y", title: "Market notes" }] },
        error: null,
      },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ index: 0, app: "web", action: "search", status: "done", label: "Searched the web for “fine jewelry trends”" });
    expect(steps[0].preview).toEqual({
      type: "sources",
      items: [
        { title: "Trend report", url: "https://a.example/x", domain: "a.example" },
        { title: "Market notes", url: "https://b.example/y", domain: "b.example" },
      ],
    });
  });

  it("pairs parallel gateway calls with their inner calls in order", () => {
    const steps = interpretCalls([
      gateway("composio_search_tools", { queries: [] }),
      gateway("search_memory", { query: "vendors" }),
      { name: "composio_search_tools", input: { queries: [] }, output: "x", error: null },
      { name: "search_memory", input: { query: "vendors" }, output: "Casting house is Acme", error: null },
    ]);
    expect(steps.map((s) => [s.index, s.label, s.hidden ?? false])).toEqual([
      [0, "Found the right tool", true],
      [1, "Checked what I know about “vendors”", false],
    ]);
    expect(steps[1].preview).toEqual({ type: "text", text: "Casting house is Acme" });
  });

  it("turns status-code narration into plain words", () => {
    const [step] = interpretCalls([{ name: "composio_remote_workbench", input: { code_to_execute: "x", current_step: "FETCHING_EMAILS" }, output: null, error: null }]);
    expect(step.label).toBe("Fetching emails");
  });

  it("shows a running gateway call by its real tool before the inner call arrives", () => {
    const [step] = interpretCalls([{ name: "execute_tool", input: { tool_name: "GMAIL_FETCH_EMAILS", arguments: { query: "from:casting" } }, output: null, error: null }]);
    expect(step).toMatchObject({ app: "gmail", status: "running", label: "Checking Gmail" });
  });

  it("reads Gmail results through multi-execute and lists what was found", () => {
    const steps = interpretCalls([
      gateway("GMAIL_FETCH_EMAILS", { query: "invoice", max_results: 5 }),
      {
        name: "composio_multi_execute_tool",
        input: { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { query: "invoice" }, account: "a" }], sync_response_to_workbench: false },
        output: toolMessage({
          successful: true,
          error: null,
          log_id: "l",
          data: {
            results: [
              {
                tool_slug: "GMAIL_FETCH_EMAILS",
                index: 0,
                response: {
                  successful: true,
                  data: {
                    messages: [
                      { subject: "Invoice #12", sender: "Casting Co <billing@casting.example>", display_url: "https://mail.google.com/mail/u/0/#inbox/1" },
                      { subject: "Re: order", sender: "Stone Supplier" },
                    ],
                  },
                },
              },
            ],
          },
        }),
        error: null,
      },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ app: "gmail", action: "read", status: "done", label: "Checked Gmail" });
    expect(steps[0].preview).toEqual({
      type: "items",
      items: [
        { primary: "Invoice #12", secondary: "Casting Co <billing@casting.example>", url: "https://mail.google.com/mail/u/0/#inbox/1" },
        { primary: "Re: order", secondary: "Stone Supplier", url: undefined },
      ],
    });
  });

  it("uses the agent's current_step narration and never its thought", () => {
    const [step] = interpretCalls([
      {
        name: "composio_remote_workbench",
        input: { code_to_execute: "print(42)", thought: "INTERNAL REASONING", current_step: "Totaling last month's orders" },
        output: toolMessage({ successful: true, data: { stdout: "42", stderr: "", error: "" } }),
        error: null,
      },
    ]);
    expect(step.label).toBe("Totaling last month's orders");
    expect(JSON.stringify(step)).not.toContain("INTERNAL REASONING");
    expect(step.preview).toEqual({ type: "code", language: "python", code: "print(42)", output: "42" });
  });

  it("reads workbench output from an MCP CallToolResult (recorded shape)", () => {
    const code = 'products = fetch_shopify_products("shop.example")\nprint(len(products))';
    const payload = JSON.stringify({
      successful: true,
      data: { results: "", stdout: "OK source=95 matched=95 written=95\n", stderr: "", error: "" },
      error: null,
      log_id: "log_x",
    });
    const steps = interpretCalls([
      gateway("composio_remote_workbench", { code_to_execute: code, current_step: "Building the inventory spreadsheet", thought: "x" }, {
        type: "tool",
        tool_call_id: "t",
        artifact: null,
        content: payload,
      }),
      {
        name: "composio_remote_workbench",
        input: { code_to_execute: code, current_step: "Building the inventory spreadsheet", thought: "x" },
        output: { meta: null, content: [{ type: "text", text: payload, annotations: null, meta: null }], structuredContent: null, isError: false },
        error: null,
      },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ status: "done", label: "Building the inventory spreadsheet", app: "code" });
    expect(steps[0].preview).toMatchObject({ type: "code", output: "OK source=95 matched=95 written=95" });
  });

  it("turns STEP and ARTIFACT markers into progress and a file card, and nothing else", () => {
    const stdout = [
      "created https://docs.google.com/spreadsheets/d/abc/edit",
      "STEP Fetched 95 products from shop.example",
      'STEP Wrote 95 rows to the "Inventory" tab',
      'ARTIFACT {"id": "abc", "kind": "spreadsheet", "title": "Shop - Inventory", "url": "https://docs.google.com/spreadsheets/d/abc/edit", "description": "95 rows · 11 columns", "source": "Google Sheets"}',
      'ARTIFACT {"id": "bad", "kind": "file", "title": "Nope", "url": "javascript:alert(1)"}',
      "OK source=95 written=95",
      "not a STEP marker: STEP inside text",
    ].join("\n");
    const [step] = interpretCalls([
      {
        name: "composio_remote_workbench",
        input: { code_to_execute: "run()", current_step: "Building the inventory spreadsheet" },
        output: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { stdout } }) }], isError: false },
        error: null,
      },
    ]);
    expect(step.preview).toMatchObject({
      type: "code",
      steps: ["Fetched 95 products from shop.example", 'Wrote 95 rows to the "Inventory" tab'],
    });
    const output = (step.preview as { output?: string }).output ?? "";
    expect(output).toContain("OK source=95");
    expect(output).not.toContain("ARTIFACT");
    expect(step.artifacts).toEqual([
      {
        id: "abc",
        kind: "spreadsheet",
        title: "Shop - Inventory",
        description: "95 rows · 11 columns",
        source: "Google Sheets",
        url: "https://docs.google.com/spreadsheets/d/abc/edit",
      },
    ]);
  });

  it("never shows raw JSON: memory documents become titles and summaries", () => {
    const docs = {
      documents: [
        { id: "d1", title: "Business entity", type: "text", status: "done", createdAt: "2026-01-01", summary: "The shop is run by Example LLC." },
        { id: "d2", title: "Owner preferences", type: "text", status: "done", summary: "Keep replies short and warm." },
      ],
    };
    const [step] = interpretCalls([
      { name: "list_documents", input: { limit: 10 }, output: { content: [{ type: "text", text: JSON.stringify(docs) }], isError: false }, error: null },
    ]);
    expect(step.label).toBe("Checked what I know about your business");
    expect(step.preview).toEqual({
      type: "items",
      items: [
        { primary: "Business entity", secondary: "The shop is run by Example LLC." },
        { primary: "Owner preferences", secondary: "Keep replies short and warm." },
      ],
    });
    expect(JSON.stringify(step.preview)).not.toContain("createdAt");
  });

  it("omits a receipt rather than show unreadable data", () => {
    const [step] = interpretCalls([{ name: "get_profile", input: {}, output: '{"weird": {"nested": [1,2,3]}}', error: null }]);
    expect(step.preview).toBeUndefined();
  });

  it("treats tool-gateway failure and timeout reports as failures with a readable reason", () => {
    const [timedOut, failed] = interpretCalls([
      gateway("composio_search_tools", { queries: [] }, { type: "tool", tool_call_id: "t", content: "Tool composio_search_tools timed out after 45s (tried twice). The service didn't respond; try another approach or tell the user." }),
      gateway("GMAIL_FETCH_EMAILS", {}, { type: "tool", tool_call_id: "u", content: "Tool GMAIL_FETCH_EMAILS failed: RuntimeError: Rate limited. Do not blindly retry writes." }),
    ]);
    expect(timedOut).toMatchObject({ status: "failed", detail: "The service didn't respond within 45 seconds.", label: "Looking for the right tool didn't work" });
    expect(timedOut.hidden).toBeUndefined();
    expect(failed).toMatchObject({ status: "failed", app: "gmail", detail: "The app is rate-limiting requests right now." });
  });

  it("finds readable results from apps it has no special handling for, across multi-tool calls", () => {
    const [step] = interpretCalls([
      {
        name: "composio_multi_execute_tool",
        input: { tools: [{ tool_slug: "GRANOLA_LIST_MEETINGS", arguments: {} }, { tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }], current_step: "Checking notes and emails with Franzi" },
        output: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                successful: true,
                data: {
                  results: [
                    { tool_slug: "GRANOLA_LIST_MEETINGS", response: { successful: true, data: { notes: [{ title: "Weekly sync with Franzi", summary: "Agreed on the launch date." }] } } },
                    { tool_slug: "GMAIL_FETCH_EMAILS", response: { successful: true, data: { messages: [{ subject: "Re: launch", sender: "Franzi" }] } } },
                  ],
                },
              }),
            },
          ],
          isError: false,
        },
        error: null,
      },
    ]);
    expect(step).toMatchObject({ label: "Checking notes and emails with Franzi", app: "granola" });
    expect(step.preview).toEqual({ type: "items", items: [{ primary: "Weekly sync with Franzi", secondary: "Agreed on the launch date." }] });
  });

  it("pairs a retry with its own call, not an earlier failed one (recorded shape)", () => {
    const slug = "GRANOLA_MCP_QUERY_GRANOLA_MEETINGS";
    const answer = JSON.stringify({
      successful: true,
      data: { results: [{ tool_slug: slug, index: 0, response: { successful: true, data: { data: "Found 9 meetings…" } } }] },
    });
    const steps = interpretCalls([
      gateway(slug, { query: "Franzi" }, `Unknown tool '${slug}'. Close matches: []`),
      { name: "discover_tools", input: { query: slug }, output: "[]", error: null },
      gateway("composio_multi_execute_tool", { tools: [{ tool_slug: slug, arguments: { query: "Franzi" } }], current_step: "Searching Granola notes for Franzi" }, "ok"),
      {
        name: "composio_multi_execute_tool",
        input: { tools: [{ tool_slug: slug, arguments: { query: "Franzi" } }], current_step: "Searching Granola notes for Franzi" },
        output: { content: [{ type: "text", text: answer }], isError: false },
        error: null,
      },
    ]).filter((s) => !s.hidden);
    expect(steps.map((s) => [s.index, s.status, s.app])).toEqual([
      [0, "failed", "granola"],
      [2, "done", "granola"],
    ]);
    expect(steps[0].detail).toBe("Tried a tool that isn't reachable that way.");
    expect(steps[1].preview).toEqual({ type: "text", text: "Found 9 meetings…" });
  });

  it("puts common technical failures in plain words", () => {
    const [step] = interpretCalls([gateway("GMAIL_SEND_EMAIL", {}, "Tool GMAIL_SEND_EMAIL failed: HTTPError: 401 Unauthorized. Do not blindly retry writes.")]);
    expect(step.detail).toBe("The app isn't connected or needs to be re-authorized.");
  });

  it("treats an MCP isError result as a failure", () => {
    const [step] = interpretCalls([
      { name: "composio_remote_workbench", input: { code_to_execute: "x" }, output: { content: [{ type: "text", text: "Sandbox crashed" }], isError: true }, error: null },
    ]);
    expect(step).toMatchObject({ status: "failed", detail: "Sandbox crashed" });
  });

  it("marks failures from Composio envelopes and tool errors, with the reason", () => {
    const [workbench, nav] = interpretCalls([
      { name: "composio_remote_workbench", input: { code_to_execute: "x" }, output: toolMessage({ successful: false, error: "Sandbox timed out", data: {} }), error: null },
      { name: "navigate", input: { url: "https://airline.example/book" }, output: null, error: "Session not authenticated" },
    ]);
    expect(workbench).toMatchObject({ status: "failed", detail: "Sandbox timed out" });
    expect(nav).toMatchObject({ status: "failed", app: "browser", label: "Couldn't open airline.example", detail: "The app isn't connected or needs to be re-authorized." });
  });

  it("hides tool-discovery plumbing but keeps it in the count", () => {
    const steps = interpretCalls([
      { name: "discover_tools", input: { query: "gmail" }, output: {}, error: null },
      { name: "get_current_date", input: {}, output: {}, error: null },
      { name: "add_memory", input: { content: "Fiscal year starts in February" }, output: "saved", error: null },
    ]);
    expect(steps).toHaveLength(3);
    expect(steps.filter((s) => s.hidden)).toHaveLength(2);
    expect(steps[2]).toMatchObject({ app: "memory", label: "Noted this for next time", preview: { type: "text", text: "Fiscal year starts in February" } });
  });

  it("names Composio apps and verbs from the slug", () => {
    const labels = interpretCalls(
      ["SHOPIFY_GET_ORDERS", "GOOGLESHEETS_BATCH_UPDATE", "GMAIL_SEND_EMAIL", "SLACK_SEARCH_MESSAGES", "ACME_DO_THING"].map((slug) => ({
        name: slug,
        input: {},
        output: {},
        error: null,
      })),
    ).map((s) => [s.app, s.label]);
    expect(labels).toEqual([
      ["shopify", "Checked Shopify"],
      ["sheets", "Updated Google Sheets"],
      ["gmail", "Sent an email"],
      ["slack", "Searched Slack"],
      ["acme", "Worked in Acme"],
    ]);
  });

  it("shows rows written to a sheet as a table, and a created sheet as an artifact", () => {
    const [write, create] = interpretCalls([
      {
        name: "GOOGLESHEETS_BATCH_UPDATE",
        input: { sheet_name: "Orders", values: [["Month", "Revenue"], ["Jan", 1200], ["Feb", 900]] },
        output: { successful: true, data: {} },
        error: null,
      },
      {
        name: "GOOGLESHEETS_CREATE_GOOGLE_SHEET1",
        input: { title: "Q3 orders" },
        output: { successful: true, data: { spreadsheetId: "abc", spreadsheetUrl: "https://docs.google.com/spreadsheets/d/abc/edit", properties: { title: "Q3 orders" } } },
        error: null,
      },
    ]);
    expect(write.preview).toEqual({ type: "table", columns: ["Month", "Revenue"], rows: [["Jan", "1200"], ["Feb", "900"]], total: undefined, title: "Orders" });
    expect(create).toMatchObject({ label: "Created a spreadsheet", app: "sheets" });
    expect(create.artifacts?.[0]).toEqual({ id: "abc", kind: "spreadsheet", title: "Q3 orders", source: "Google Sheets", url: "https://docs.google.com/spreadsheets/d/abc/edit" });
  });

  it("caps long lists and keeps the true total", () => {
    const results = Array.from({ length: 30 }, (_, i) => ({ url: `https://s${i}.example/`, title: `Result ${i}` }));
    const [step] = interpretCalls([{ name: "search", input: { query: "q" }, output: { results }, error: null }]);
    expect(step.preview).toMatchObject({ type: "sources", total: 30 });
    expect((step.preview as { items: unknown[] }).items).toHaveLength(8);
  });

  it("surfaces a connection link the agent created", () => {
    const [step] = interpretCalls([
      {
        name: "composio_manage_connections",
        input: { toolkits: [{ name: "browserbase_tool", action: "add" }] },
        output: toolMessage({ successful: true, data: { results: { browserbase_tool: { redirect_url: "https://connect.composio.dev/link/abc" } } } }),
        error: null,
      },
    ]);
    expect(step).toMatchObject({ app: "browser", action: "connect", preview: { type: "link", url: "https://connect.composio.dev/link/abc" } });
  });
});

describe("sanitizing", () => {
  it("masks credentials in code and output", () => {
    const masked = maskSecrets('api_key = "sk_live_abcdefghijklmnop1234"\nheaders={"Authorization": "Bearer abc.def.ghijklmnop"}');
    expect(masked).not.toContain("abcdefghijklmnop1234");
    expect(masked).not.toContain("abc.def.ghijklmnop");
  });

  it("only links https URLs and hides secret query parameters", () => {
    expect(safeUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeUrl("http://insecure.example")).toBeUndefined();
    expect(safeUrl("https://x.example/cb?token=abc&page=2")).toBe("https://x.example/cb?token=%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2&page=2");
  });

  it("never puts secrets from workbench code into previews", () => {
    const [step] = interpretCalls([
      { name: "composio_remote_workbench", input: { code_to_execute: 'token = "ya29.secretsecretsecretsecret"\nprint(1)' }, output: toolMessage({ successful: true, data: { stdout: "1" } }), error: null },
    ]);
    expect(JSON.stringify(step.preview)).not.toContain("secretsecretsecret");
  });
});

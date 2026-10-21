import { describe, expect, it } from "vitest";
import { evidenceFor } from "./evidence";
import { interpretCalls, talksMachinery, withoutRepeats, type ToolCall } from "./index";
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
  it("reads pages by link (Exa get_contents) as a web read, with sources and evidence", () => {
    const page = { url: "https://acme.example/press/launch", id: "https://acme.example/press/launch", title: "Acme launches", published_date: null, author: null, image: null, text: "Acme opened a second studio in March." };
    const calls: ToolCall[] = [
      { name: "get_contents", input: { ids: [page.url] }, output: { results: [page] }, error: null },
      gateway("get_contents", { ids: [page.url] }, toolMessage({ results: [page] })),
    ];
    for (const call of calls) {
      const [step] = interpretCalls([call]);
      expect(step).toMatchObject({
        label: "Read acme.example",
        status: "done",
        app: "web",
        preview: { type: "sources", items: [{ title: "Acme launches", url: page.url, domain: "acme.example" }] },
      });
      expect(evidenceFor([call])).toEqual([expect.objectContaining({ url: page.url, app: "web", text: expect.stringContaining("second studio in March") })]);
    }
  });

  it("treats any other tool that returns a list of web results the same way", () => {
    const results = [
      { url: "https://a.example/1", title: "One", text: "First page." },
      { url: "https://b.example/2", title: "Two", text: "Second page." },
    ];
    const call: ToolCall = { name: "find_similar", input: { url: "https://acme.example/" }, output: { results }, error: null };
    const [step] = interpretCalls([call]);
    expect(step).toMatchObject({ label: "Read acme.example", app: "web", preview: { type: "sources", items: [{ url: results[0].url }, { url: results[1].url }] } });
    const [noInput] = interpretCalls([{ ...call, input: {} }]);
    expect(noInput.label).toBe("Read 2 pages");
    expect(evidenceFor([call]).map((e) => e.app)).toEqual(["web", "web"]);
  });

  it("hides report_timeline: its timeline shows in Results, not as a step", () => {
    const [step] = interpretCalls([
      { name: "report_timeline", input: { question: "Why?", entries: [] }, output: JSON.stringify({ timeline: { entries: [] } }), error: null },
    ]);
    expect(step).toMatchObject({ hidden: true, status: "done" });
  });

  it("shows plan updates and tracked rows as plain steps the member can see", () => {
    const [plan, record] = interpretCalls([
      {
        name: "update_plan",
        input: { steps: [{ text: "Find roles", status: "done" }, { text: "Tailor the top 3", status: "doing" }, { text: "Send outreach", status: "todo" }] },
        output: JSON.stringify({ plan_update: { steps: [] }, note: "Plan saved." }),
        error: null,
      },
      {
        name: "save_record",
        input: { collection: "applications", key: "https://jobs.example/1", title: "Senior PM — Acme", status: "discovered" },
        output: JSON.stringify({ record: {}, note: "Saved to the owner's tracker." }),
        error: null,
      },
    ]);
    expect(plan).toMatchObject({ label: "Updated the plan", app: "tracker", action: "write", status: "done" });
    expect(plan.preview).toEqual({ type: "text", text: "Plan: 1 of 3 steps done; next: Tailor the top 3" });
    expect(plan.hidden).toBeFalsy();
    expect(record).toMatchObject({ label: "Tracked “Senior PM — Acme”", app: "tracker", action: "write" });
    expect(record.preview).toEqual({ type: "text", text: "Tracked “Senior PM — Acme” (discovered)" });
  });

  it("shows a link filed in the Library as a step, and a refused one as a failed step, never as evidence", () => {
    const filed: ToolCall = {
      name: "file_link",
      input: { url: "https://docs.google.com/document/d/abc/edit", title: "Q3 pricing plan" },
      output: JSON.stringify({ library_item: { url: "https://docs.google.com/document/d/abc/edit", title: "Q3 pricing plan" }, note: "Saved." }),
      error: null,
    };
    const refusedCall: ToolCall = {
      name: "file_link",
      input: { url: "http://example.com/x", title: "Notes" },
      output: "Not saved: give the item's https link exactly as the owner gave it or a tool returned it.",
      error: null,
    };
    const [step, refused] = interpretCalls([filed, refusedCall]);
    expect(step).toMatchObject({ label: "Saved “Q3 pricing plan” to your Library", app: "library", action: "write", status: "done" });
    expect(step.preview).toEqual({ type: "text", text: "Saved “Q3 pricing plan” to your Library" });
    expect(step.hidden).toBeFalsy();
    expect(refused).toMatchObject({ label: "Couldn't save “Notes” to your Library", status: "failed", detail: "Only https links with a name can go in the Library." });
    // The agent supplied the link; its own echo doesn't make the link citable.
    expect(evidenceFor([filed])).toEqual([]);
  });

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
      [0, "Figured out how to do this", true],
      [1, "Checked what I know about “vendors”", false],
    ]);
    expect(steps[1].preview).toEqual({ type: "text", text: "Casting house is Acme", query: "vendors" });
  });

  it("turns status-code narration into plain words", () => {
    const [step] = interpretCalls([{ name: "composio_remote_workbench", input: { code_to_execute: "x", current_step: "FETCHING_EMAILS" }, output: null, error: null }]);
    expect(step.label).toBe("Fetching emails");
  });

  it("shows a running gateway call by its real tool before the inner call arrives", () => {
    const [step] = interpretCalls([{ name: "execute_tool", input: { tool_name: "GMAIL_FETCH_EMAILS", arguments: { query: "from:casting" } }, output: null, error: null }]);
    expect(step).toMatchObject({ app: "gmail", status: "running", label: "Checking Gmail" });
  });

  it("never names tools on the status line, even for hidden plumbing", () => {
    const steps = interpretCalls([
      { name: "execute_tool", input: {}, output: null, error: null },
      { name: "discover_tools", input: {}, output: null, error: null },
      { name: "composio_search_tools", input: { queries: [] }, output: null, error: null },
    ]);
    for (const step of steps) expect(step.label).not.toMatch(/\btools?\b/i);
  });

  it("tells progress lines about machinery from ones about the work", () => {
    expect(talksMachinery("The search tool isn't callable directly, so I'll use discovery.")).toBe(true);
    expect(talksMachinery("Shopify is available. Let me load the order-listing tool's details.")).toBe(true);
    expect(talksMachinery("Let me look through your Granola notes for Franzi.")).toBe(false);
    expect(talksMachinery("I'll run discover_tools to find the right action.")).toBe(true);
  });

  it("doesn't count quoted titles or work talk about discovery as machinery", () => {
    expect(talksMachinery("Tracked “Senior Product Manager, Growth (Discovery) - Stash”")).toBe(false);
    expect(talksMachinery('Tracked "Tools Engineer, MCP Platform"')).toBe(false);
    expect(talksMachinery("Let me pull your notes from last week's discovery call.")).toBe(false);
    expect(talksMachinery("The “Acme” search tool isn't callable.")).toBe(true);
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
      query: "invoice",
    });
  });

  it("keeps what worked when one tool in a batch fails because its app isn't connected", () => {
    const input = {
      tools: [
        { tool_slug: "GMAIL_FETCH_EMAILS", arguments: { query: "Ski trip" } },
        { tool_slug: "GOOGLECALENDAR_EVENTS_LIST", arguments: { q: "Ski trip" } },
      ],
    };
    const failure = `MCP tool 'COMPOSIO_MULTI_EXECUTE_TOOL' failed: ${JSON.stringify({
      successful: false,
      data: {
        results: [
          {
            response: { successful: true, data: { messages: [{ subject: "Reservation Confirmation", sender: "Resort", display_url: "https://mail.google.com/mail/u/0/#inbox/1" }] } },
            tool_slug: "GMAIL_FETCH_EMAILS",
            index: 0,
          },
          {
            error: "No active connection found for toolkit(s) 'googlecalendar' in this session. To fix this, call COMPOSIO_MANAGE_CONNECTIONS with toolkits=['googlecalendar'].",
            tool_slug: "GOOGLECALENDAR_EVENTS_LIST",
            index: 1,
          },
        ],
        success_count: 1,
        error_count: 1,
      },
      error: "1 out of 2 tools failed",
    })}`;
    const steps = interpretCalls([
      gateway("composio_multi_execute_tool", input, { content: `Tool composio_multi_execute_tool failed: ValueError: ${failure}`, type: "tool", tool_call_id: "t" }),
      { name: "composio_multi_execute_tool", input, output: null, error: failure },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ app: "gmail", status: "done", label: "Checked Gmail" });
    expect(steps[0].detail).toBeUndefined();
    expect(steps[0].preview).toMatchObject({ type: "items", items: [{ primary: "Reservation Confirmation", url: "https://mail.google.com/mail/u/0/#inbox/1" }] });
  });

  it("says plainly which app isn't connected when that's all that failed", () => {
    const input = { tools: [{ tool_slug: "GOOGLECALENDAR_EVENTS_LIST", arguments: { q: "Ski trip" } }] };
    const failure = `MCP tool 'COMPOSIO_MULTI_EXECUTE_TOOL' failed: ${JSON.stringify({
      successful: false,
      data: { results: [{ error: "No active connection found for toolkit(s) 'googlecalendar' in this session.", tool_slug: "GOOGLECALENDAR_EVENTS_LIST", index: 0 }] },
      error: "1 out of 1 tools failed",
    })}`;
    const [step] = interpretCalls([{ name: "composio_multi_execute_tool", input, output: null, error: failure }]);
    expect(step).toMatchObject({ status: "failed", detail: "Google Calendar isn't connected." });
  });

  it("reads a large result from Composio's data_preview sample, counting what it left out", () => {
    const [step] = interpretCalls([
      {
        name: "composio_multi_execute_tool",
        input: { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { query: "newer_than:10d delay" } }], current_step: "Searching Gmail for delays" },
        output: toolMessage({
          successful: true,
          error: null,
          data: {
            results: [
              {
                tool_slug: "GMAIL_FETCH_EMAILS",
                response: {
                  successful: true,
                  data_preview: {
                    messages: [
                      { subject: "Clasp shipment delayed", sender: "Casting Co", display_url: "https://mail.google.com/mail/u/0/#inbox/1", labelIds: ["INBOX", "...2 more items"] },
                      { subject: "Order question", sender: "A customer" },
                      "...48 more items",
                    ],
                  },
                },
              },
            ],
            remote_file_info: { file_path: "/mnt/files/mex/x.json" },
          },
        }),
        error: null,
      },
    ]);
    expect(step).toMatchObject({ app: "gmail", status: "done", label: "Searching Gmail for delays" });
    expect(step.preview).toMatchObject({ type: "items", total: 50, items: [{ primary: "Clasp shipment delayed" }, { primary: "Order question" }] });
  });

  it("drops the sample marker from generic lists too", () => {
    const [step] = interpretCalls([
      {
        name: "SHOPIFY_GET_ORDERS_WITH_FILTERS",
        input: {},
        output: toolMessage({ successful: true, data_preview: { orders: [{ name: "#1042", status: "refunded" }, "...9 more items"] } }),
        error: null,
      },
    ]);
    expect(step.preview).toMatchObject({ type: "items", total: 10, items: [{ primary: "#1042" }] });
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
    expect(step.label).toBe("Checked what I know about you");
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
    expect(timedOut).toMatchObject({ status: "failed", detail: "The service didn't respond within 45 seconds.", label: "Couldn't figure out how to do this" });
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
    expect(steps[0].detail).toBe("Asked for a tool called “granola mcp query granola meetings”, which doesn't exist here.");
    expect(steps[1].preview).toEqual({ type: "text", text: "Found 9 meetings…", query: "Franzi" });
  });

  it("pairs by arguments when a gateway call never produced an inner call (recorded shape)", () => {
    const slug = "GRANOLA_MCP_QUERY_GRANOLA_MEETINGS";
    const args = (q: string, step: string) => ({ tools: [{ tool_slug: slug, arguments: { query: q } }], sync_response_to_workbench: false, current_step: step });
    const answer = (text: string) => ({
      content: [{ type: "text", text: JSON.stringify({ successful: true, data: { results: [{ tool_slug: slug, response: { successful: true, data: { data: text } } }] } }) }],
      isError: false,
    });
    const rejected = { type: "tool", tool_call_id: "t", content: "Invalid arguments for composio_multi_execute_tool: missing tools" };
    const steps = interpretCalls([
      gateway("composio_multi_execute_tool", args("a", "First search"), rejected),
      gateway("composio_multi_execute_tool", args("b", "Second search"), "ok"),
      { name: "composio_multi_execute_tool", input: args("b", "Second search"), output: answer("Second answer text here."), error: null },
      gateway("composio_multi_execute_tool", args("c", "Third search"), "ok"),
      { name: "composio_multi_execute_tool", input: args("c", "Third search"), output: answer("Third answer text here."), error: null },
    ]).filter((s) => !s.hidden);
    expect(steps.map((s) => [s.label, s.status, s.preview?.type === "text" ? s.preview.text : s.preview?.type])).toEqual([
      ["First search", "failed", undefined],
      ["Second search", "done", "Second answer text here."],
      ["Third search", "done", "Third answer text here."],
    ]);
  });

  it("puts common technical failures in plain words", () => {
    const [step] = interpretCalls([gateway("GMAIL_SEND_EMAIL", {}, "Tool GMAIL_SEND_EMAIL failed: HTTPError: 401 Unauthorized. Do not blindly retry writes.")]);
    expect(step.detail).toBe("The app isn't connected or needs to be re-authorized.");
  });

  it("words every failure plainly, however the tool reported it", () => {
    const routerError =
      "COMPOSIO_REMOTE_WORKBENCH is a Tool Router helper tool and cannot be executed inside COMPOSIO_MULTI_EXECUTE_TOOL. Run non-meta tools directly instead.";
    const steps = interpretCalls([
      // A whole-batch failure, and one tool's failure inside the batch's results.
      { name: "composio_multi_execute_tool", input: { tools: [{ tool_slug: "COMPOSIO_REMOTE_WORKBENCH", arguments: { code_to_execute: "x" } }] }, output: toolMessage({ successful: false, error: routerError, data: {} }), error: null },
      {
        name: "composio_multi_execute_tool",
        input: { tools: [{ tool_slug: "COMPOSIO_REMOTE_WORKBENCH", arguments: { code_to_execute: "x" } }] },
        output: null,
        error: `MCP tool 'COMPOSIO_MULTI_EXECUTE_TOOL' failed: ${JSON.stringify({ successful: false, data: { results: [{ tool_slug: "COMPOSIO_REMOTE_WORKBENCH", error: routerError, index: 0 }] }, error: "1 out of 1 tools failed" })}`,
      },
      { name: "composio_remote_workbench", input: { code_to_execute: "x" }, output: { content: [{ type: "text", text: "KeyError: 'video_id'" }], isError: true }, error: null },
      { name: "run_python", input: { code: "x" }, output: toolMessage({ successful: true, data: { stdout: "", stderr: "Traceback (most recent call last):\n  NameError: name 'segs' is not defined" } }), error: null },
    ]);
    expect(steps.map((s) => [s.status, s.detail])).toEqual([
      ["failed", "Called its tool runner the wrong way."],
      ["failed", "Called its tool runner the wrong way."],
      ["failed", "Something went wrong on the app's side."],
      ["failed", "The code hit an error."],
    ]);
  });

  it("keeps a plain reason as written, contractions and all", () => {
    const [step] = interpretCalls([{ name: "start", input: {}, output: toolMessage({ success: false, error: "The browser wasn't available." }), error: null }]);
    expect(step).toMatchObject({ status: "failed", detail: "The browser wasn't available." });
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
    expect(workbench).toMatchObject({ status: "failed", detail: "The app took too long to respond." });
    expect(nav).toMatchObject({ status: "failed", app: "browser", label: "Couldn't open airline.example", detail: "The app isn't connected or needs to be re-authorized." });
  });

  it("hides a started browser session (connection details only) but shows when it didn't start", () => {
    // Browserbase's start: an MCP result whose text is the session's connection details.
    const started = (payload: unknown) => ({ meta: null, content: [{ type: "text", text: JSON.stringify(payload), annotations: null, meta: null }], structuredContent: null, isError: false });
    const [ok, unavailable] = interpretCalls([
      { name: "start", input: {}, output: started({ success: true, data: { sessionId: "00000000-0000-0000-0000-000000000000", cdpUrl: `wss://connect.browser.example/?signingKey=${"x".repeat(600)}`, available: true } }), error: null },
      { name: "start", input: {}, output: started({ success: false, data: { available: false } }), error: null },
    ]);
    expect(ok).toMatchObject({ status: "done", app: "browser", label: "Opened a browser", hidden: true });
    expect(ok.preview).toBeUndefined();
    expect(unavailable).toMatchObject({ status: "failed", label: "Couldn't open a browser", detail: "The browser wasn't available." });
    expect(unavailable.hidden).toBeUndefined();
  });

  it("reads what the hosted browser extracted, however short", () => {
    const mcp = (payload: unknown) => ({ meta: null, content: [{ type: "text", text: JSON.stringify(payload), annotations: null, meta: null }], structuredContent: null, isError: false });
    const [step] = interpretCalls([
      { name: "extract", input: { instruction: "the page title" }, output: mcp({ success: true, data: { result: { extraction: "Example Domain" }, actionId: "00000000-0000-0000-0000-000000000000" } }), error: null },
    ]);
    expect(step).toMatchObject({ status: "done", app: "browser", label: "Read the page", preview: { type: "text", text: "Example Domain" } });
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

  describe("composio_manage_connections", () => {
    const linkOutput = toolMessage({ successful: true, data: { results: { gmail: { redirect_url: "https://connect.composio.dev/link/g1" } } } });
    const statusOutput = toolMessage({ successful: true, data: { results: { gmail: { status: "active" } } } });

    it("names the app from plain toolkit names, through take_action", () => {
      const [running] = interpretCalls([
        { name: "take_action", input: { tool_name: "composio_manage_connections", arguments: { toolkits: ["gmail"] } }, output: null, error: null },
      ]);
      expect(running).toMatchObject({ app: "gmail", action: "connect", status: "running", label: "Connecting Gmail" });

      const [done] = interpretCalls([
        { name: "take_action", input: { tool_name: "composio_manage_connections", arguments: { toolkits: ["gmail"] } }, output: "ok", error: null },
        { name: "composio_manage_connections", input: { toolkits: ["gmail"] }, output: linkOutput, error: null },
      ]);
      expect(done).toMatchObject({ app: "gmail", status: "done", label: "Got a link to connect Gmail", preview: { type: "link", url: "https://connect.composio.dev/link/g1", title: "Connect Gmail" } });

      const [failed] = interpretCalls([
        { name: "take_action", input: { tool_name: "composio_manage_connections", arguments: { toolkits: ["gmail"] } }, output: "Tool composio_manage_connections failed: 503 Service Unavailable", error: null },
      ]);
      expect(failed).toMatchObject({ status: "failed", label: "Couldn't connect Gmail" });
    });

    it("names the app when called directly, with record or string toolkits", () => {
      const [direct] = interpretCalls([{ name: "composio_manage_connections", input: { toolkits: ["gmail"] }, output: statusOutput, error: null }]);
      expect(direct).toMatchObject({ app: "gmail", label: "Checked the Gmail connection" });
      const [records] = interpretCalls([
        { name: "composio_manage_connections", input: { toolkits: [{ name: "gmail" }, { name: "googlesheets" }] }, output: statusOutput, error: null },
      ]);
      expect(records.label).toBe("Checked the Gmail and Google Sheets connections");
    });

    it("reads naturally without toolkits", () => {
      const [viaGateway] = interpretCalls([
        { name: "take_action", input: { tool_name: "composio_manage_connections", arguments: {} }, output: null, error: null },
      ]);
      expect(viaGateway).toMatchObject({ app: "agent", label: "Checking your app connections" });
      const [direct] = interpretCalls([{ name: "composio_manage_connections", input: {}, output: { error: "boom" }, error: "boom" }]);
      expect(direct).toMatchObject({ status: "failed", label: "Couldn't check your app connections" });
    });
  });

  it("never produces a label with a doubled word, for any state of a representative set of calls", () => {
    const inputs: [string, Record<string, unknown>][] = [
      ["composio_manage_connections", { toolkits: ["gmail"] }],
      ["composio_manage_connections", { toolkits: [] }],
      ["composio_manage_connections", {}],
      ["composio_wait_for_connections", { toolkits: ["gmail"] }],
      ["composio_wait_for_connections", {}],
      ["composio_multi_execute_tool", { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }, { tool_slug: "GOOGLESHEETS_BATCH_UPDATE", arguments: {} }] }],
      ["composio_multi_execute_tool", {}],
      ["GMAIL_SEND_EMAIL", { to: "a@example.test" }],
      ["GMAIL_FETCH_EMAILS", {}],
      ["GOOGLESHEETS_CREATE_GOOGLE_SHEET1", {}],
      ["SHOPIFY_GET_ORDERS", {}],
      ["UNKNOWNAPP_DO_THING", {}],
      ["composio_remote_workbench", { code_to_execute: "print(1)" }],
      ["search", { query: "x" }],
      ["search_memory", {}],
      ["add_memory", { content: "x" }],
      ["navigate", { url: "https://example.com" }],
      ["navigate", {}],
      ["extract", {}],
      ["calculator", { expression: "1+1" }],
      ["load_skill", {}],
      ["remember", {}],
      ["discover_tools", {}],
      ["some_custom_tool", {}],
    ];
    const outputs: [unknown, unknown][] = [[null, null], ["ok", null], [null, "Request failed with 500"]];
    for (const [name, input] of inputs) {
      for (const [output, error] of outputs) {
        for (const calls of [
          [{ name, input, output, error }],
          [{ name: "take_action", input: { tool_name: name, arguments: input }, output, error }],
          [{ name: "execute_tool", input: { tool_name: name, arguments: input }, output, error }],
        ] as ToolCall[][]) {
          for (const step of interpretCalls(calls)) {
            expect(step.label, `${name} ${JSON.stringify(input)}`).not.toMatch(/\b([\p{L}']+)\s+\1\b/iu);
          }
        }
      }
    }
  });

  it("collapses a repeated word left by any template, but keeps quoted text", () => {
    expect(withoutRepeats("Checking your your apps connection")).toBe("Checking your apps connection");
    expect(withoutRepeats("Searching the web for “that that”")).toBe("Searching the web for “that that”");
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

describe("browser results tagged with their session", () => {
  it("still read the same, with the tag kept out of what the member sees", () => {
    const mcp = (payload: unknown) => ({ meta: null, content: [{ type: "text", text: JSON.stringify(payload), annotations: null, meta: null }], structuredContent: null, isError: false });
    const [step] = interpretCalls([
      { name: "extract", input: { instruction: "the page title" }, output: mcp({ studioBrowserSession: "33333333-3333-4333-8333-333333333333", success: true, data: { result: { extraction: "Example Domain" } } }), error: null },
    ]);
    expect(step).toMatchObject({ status: "done", app: "browser", label: "Read the page", preview: { type: "text", text: "Example Domain" } });
    expect(JSON.stringify(step)).not.toContain("studioBrowserSession");
  });
});

import { describe, expect, it } from "vitest";
import { evidenceFor, type ToolCall } from "@/lib/agent/tools";
import { buildCitations, quoted } from "./citations";

const page = "https://reviews.example/acme";
const evidence = [{ url: page, app: "web", title: "Acme reviews", text: "Acme is rated 4.5 out of 5 from 9 reviews.\nWork/Life Balance 3.4" }];

describe("buildCitations", () => {
  it("verifies a quote the tool returned for that link", () => {
    expect(buildCitations({ sources: [{ n: 1, url: page, quote: "rated 4.5 out of 5 from 9 reviews" }] }, evidence, new Set())).toEqual([
      { n: 1, url: page, quote: "rated 4.5 out of 5 from 9 reviews", quoteVerified: true, title: "Acme reviews", app: "web" },
    ]);
  });

  it("keeps a link this run returned as link-only when the quote isn't in it", () => {
    const [c] = buildCitations({ sources: [{ n: 2, url: page, quote: "management is still learning" }] }, evidence, new Set())!;
    expect(c).toMatchObject({ n: 2, quoteVerified: false });
  });

  it("drops a link no tool returned this run", () => {
    expect(buildCitations({ sources: [{ n: 1, url: "https://made-up.example", quote: "x y z" }] }, evidence, new Set())).toBeNull();
  });

  it("accepts a link only seen in a step's results, as link-only", () => {
    const [c] = buildCitations({ sources: [{ n: 1, url: "https://seen.example/", quote: "anything" }] }, [], new Set(["https://seen.example/"]))!;
    expect(c.quoteVerified).toBe(false);
  });

  it("reads aliased keys, keeps the first of a repeated number, and sorts", () => {
    const out = buildCitations(
      { sources: [{ number: "2", link: page, excerpt: "Work/Life Balance 3.4" }, { n: 1, url: page, quote: "9 reviews" }, { n: 2, url: page, quote: "other" }, "junk"] },
      evidence,
      new Set(),
    );
    expect(out?.map((c) => [c.n, c.quote, c.quoteVerified])).toEqual([
      [1, "9 reviews", true],
      [2, "Work/Life Balance 3.4", true],
    ]);
  });

  it("refuses unsafe links", () => {
    expect(buildCitations({ sources: [{ n: 1, url: "javascript:alert(1)", quote: "x y z" }] }, evidence, new Set(["javascript:alert(1)"]))).toBeNull();
  });
});

describe("quoted", () => {
  it("ignores case, spacing, markup, smart quotes and dashes", () => {
    expect(quoted("“AI analysts” for   financial firms", "Building <b>\"AI analysts\"</b>\nfor financial firms.")).toBe(true);
    expect(quoted("Dec 27 – Dec 31", "dec 27 - dec 31")).toBe(true);
    expect(quoted("…rated 4.5…", "Rated 4.5 overall")).toBe(true);
    expect(quoted("rated 5.0", "Rated 4.5 overall")).toBe(false);
  });
});

describe("evidenceFor", () => {
  it("collects text for each link from web results, app records, partial batches and browser pages", () => {
    const failure = `MCP tool 'COMPOSIO_MULTI_EXECUTE_TOOL' failed: ${JSON.stringify({
      successful: false,
      data: {
        results: [
          { tool_slug: "GMAIL_FETCH_EMAILS", response: { successful: true, data: { messages: [{ subject: "Reservation", display_url: "https://mail.google.com/mail/u/0/#inbox/1", messageText: "Five days at the resort" }] } } },
          { tool_slug: "GOOGLECALENDAR_EVENTS_LIST", error: "No active connection found for toolkit(s) 'googlecalendar'" },
        ],
      },
    })}`;
    const calls: ToolCall[] = [
      { name: "search", input: { query: "acme" }, output: { results: [{ title: "Acme reviews", url: page, text: "Rated 4.5 from 9 reviews" }] }, error: null },
      { name: "search", input: {}, output: "Title: Acme jobs\nURL: https://acme.example/careers\nText: 40 open roles\n\nTitle: Other\nURL: https://other.example\nText: nothing", error: null },
      { name: "composio_multi_execute_tool", input: {}, output: null, error: failure },
      { name: "navigate", input: { url: "https://acme.example/about" }, output: "ok", error: null },
      { name: "extract", input: {}, output: "Founded in 2021 in New York", error: null },
    ];
    const byUrl = Object.fromEntries(evidenceFor(calls).map((e) => [e.url, e]));
    expect(byUrl[page]).toMatchObject({ app: "web", title: "Acme reviews" });
    expect(byUrl[page].text).toContain("Rated 4.5 from 9 reviews");
    expect(byUrl["https://acme.example/careers"].text).toContain("40 open roles");
    expect(byUrl["https://acme.example/careers"].text).not.toContain("nothing");
    expect(byUrl["https://mail.google.com/mail/u/0/#inbox/1"]).toMatchObject({ app: "gmail", title: "Reservation" });
    expect(byUrl["https://mail.google.com/mail/u/0/#inbox/1"].text).toContain("Five days at the resort");
    expect(byUrl["https://acme.example/about"]).toMatchObject({ app: "browser", text: expect.stringContaining("Founded in 2021 in New York") });
  });

  it("ties what a browser visit returned to that page, even when the page is never read separately", () => {
    // Browserbase's navigate can return a serialized page object rather than page text.
    const visit = { meta: null, content: [{ type: "text", text: JSON.stringify({ success: true, data: { result: { page: { _url: "https://jobs.example/roles/1", conn: { _closeCode: 1006 } } } } }) }], isError: false };
    const byUrl = Object.fromEntries(
      evidenceFor([
        { name: "navigate", input: { url: "https://jobs.example/roles/1" }, output: visit, error: null },
        { name: "navigate", input: { url: "https://down.example" }, output: null, error: "No active session" },
      ]).map((e) => [e.url, e]),
    );
    expect(byUrl["https://jobs.example/roles/1"]).toMatchObject({ app: "browser", text: expect.stringContaining("https://jobs.example/roles/1") });
    expect(byUrl["https://down.example"]).toBeUndefined();
  });
});

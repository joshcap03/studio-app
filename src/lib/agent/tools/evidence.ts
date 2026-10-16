import { appForToolkit, isKnownToolkit, type AppId } from "@/lib/apps";
import { clip, firstString, isRecord, maybeJson, safeUrl, unwrapResult } from "./sanitize";
import type { ToolCall } from "./index";

// What this run's tools actually returned, as text tied to the link it came from. The agent's
// citations are checked against it: a quote counts only if it appears in the text a tool
// returned for that link. Server-side only; never sent to the browser or stored.
//
// Generic on purpose, so it holds for every tool: any record in a result with a link field
// is evidence for that link (all its text), whatever app it came from.

export interface Evidence {
  url: string;
  title?: string;
  app: AppId;
  text: string;
}

const URL_KEYS = ["url", "display_url", "webLink", "webViewLink", "htmlLink", "link", "permalink"];
const TITLE_KEYS = ["title", "subject", "name", "summary"];
const SEARCH_TOOLS = new Set(["search", "web_search", "exa_search", "search_web"]);
const PAGE_TOOLS = new Set(["extract", "observe"]);
const MAX_TEXT = 100_000;
const COMPOSIO_SLUG = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;

export function evidenceFor(calls: ToolCall[]): Evidence[] {
  const byUrl = new Map<string, Evidence>();
  const add = (url: string, app: AppId, text: string, title?: string) => {
    const body = text.trim();
    if (!body) return;
    const known = byUrl.get(url);
    if (!known) {
      byUrl.set(url, { url, app, text: body.slice(0, MAX_TEXT), ...(title ? { title: clip(title, 140) } : {}) });
    } else if (!known.text.includes(body) && known.text.length < MAX_TEXT) {
      known.text = `${known.text}\n${body}`.slice(0, MAX_TEXT);
      if (!known.title && title) known.title = clip(title, 140);
    }
  };

  let page: string | undefined;
  for (const call of calls) {
    const input = isRecord(call.input) ? call.input : {};
    if (call.name === "navigate") page = safeUrl(input.url) ?? page;
    const app = appFor(call.name);
    for (const value of resultsOf(call)) {
      // A browser page's text belongs to the page it was read from.
      if (PAGE_TOOLS.has(call.name) && page) {
        add(page, "browser", allText(value));
        continue;
      }
      if (typeof value === "string") {
        // Text search results: repeated "Title: …\nURL: …\n…" blocks.
        for (const block of value.split(/\n(?=Title:)/)) {
          const match = /Title:\s*(.*)\n\s*URL:\s*(\S+)/.exec(block);
          const url = match && safeUrl(match[2]);
          if (url) add(url, app, block, match[1]);
        }
        continue;
      }
      walk(value, app, add);
    }
  }
  return [...byUrl.values()];
}

/** Every link evidence was found for. */
export function evidenceLinks(evidence: Evidence[]): Set<string> {
  return new Set(evidence.map((e) => e.url));
}

/** The call's result, plus any result embedded in a failure (a batch where some tools worked). */
function resultsOf(call: ToolCall): unknown[] {
  const out: unknown[] = [];
  const result = call.output == null ? undefined : unwrapResult(call.output);
  for (const value of [result, typeof call.error === "string" ? call.error : undefined]) {
    if (value == null) continue;
    if (typeof value === "string" && !value.trimStart().startsWith("{") && value.includes("{")) {
      const embedded = maybeJson(value.slice(value.indexOf("{")));
      if (isRecord(embedded)) {
        out.push(embedded);
        continue;
      }
    }
    out.push(value);
  }
  return out;
}

function walk(value: unknown, app: AppId, add: (url: string, app: AppId, text: string, title?: string) => void, depth = 0): void {
  const v = maybeJson(value);
  if (depth > 8 || v == null) return;
  if (Array.isArray(v)) {
    for (const item of v) walk(item, app, add, depth + 1);
    return;
  }
  if (!isRecord(v)) return;
  // A multi-execute result names the tool each response came from.
  const here = typeof v.tool_slug === "string" ? appForToolkit(v.tool_slug) : app;
  const url = URL_KEYS.map((k) => safeUrl(v[k])).find(Boolean);
  if (url) add(url, here, allText(v), firstString(v, TITLE_KEYS));
  for (const [key, nested] of Object.entries(v)) {
    if (typeof nested === "object" || (typeof nested === "string" && /^\s*[{[]/.test(nested))) {
      if (!URL_KEYS.includes(key)) walk(nested, here, add, depth + 1);
    }
  }
}

/** All the text in a value, for matching quotes against. */
function allText(value: unknown, depth = 0): string {
  const v = maybeJson(value);
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (depth > 6 || v == null || typeof v !== "object") return "";
  const parts = Array.isArray(v) ? v.map((x) => allText(x, depth + 1)) : Object.values(v).map((x) => allText(x, depth + 1));
  return parts.filter(Boolean).join("\n").slice(0, MAX_TEXT);
}

function appFor(name: string): AppId {
  if (SEARCH_TOOLS.has(name)) return "web";
  if (PAGE_TOOLS.has(name) || name === "navigate") return "browser";
  if (COMPOSIO_SLUG.test(name) || isKnownToolkit(name)) return appForToolkit(name);
  return "agent";
}

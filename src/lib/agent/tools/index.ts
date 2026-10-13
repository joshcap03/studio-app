import { appForToolkit, appName, isKnownToolkit, type AppId } from "@/lib/apps";
import type { ActivityStatus, Artifact, StepAction, StepPreview } from "@/lib/types";
import {
  capList,
  clip,
  composioEnvelope,
  domainOf,
  firstString,
  isRecord,
  maybeJson,
  safeUrl,
  unwrapResult,
} from "./sanitize";

// Tool interpretation: turns raw tool calls into steps a business owner can follow, in plain
// language, with the app each step worked in and a receipt of what it actually did.
//
// Provider-neutral: adapters hand over normalized calls ({ name, input, output, error }) in
// the order the agent made them. Everything here is derived from those calls. Nothing is
// guessed, and agent reasoning fields (e.g. "thought") are never shown; "current_step" is
// the agent's own user-facing narration and is used as the label when present.

export interface ToolCall {
  name: string;
  input: unknown;
  /** undefined/null while the call is still running. */
  output: unknown;
  error: unknown;
}

export interface InterpretedStep {
  /** Index of the call this step starts at; stable as more calls arrive. */
  index: number;
  label: string;
  status: ActivityStatus;
  detail?: string;
  app: AppId;
  action: StepAction;
  preview?: StepPreview;
  hidden?: boolean;
  artifacts?: Artifact[];
}

interface Interpretation {
  labels: { running: string; done: string; failed?: string };
  app: AppId;
  action: StepAction;
  preview?: StepPreview;
  hidden?: boolean;
  artifacts?: Artifact[];
  /** A failure reported inside a successful-looking result (e.g. Composio successful: false). */
  innerError?: string;
}

const MAX_ITEMS = 8;
const MAX_ROWS = 50;

/** Gateway/meta tools that only find or describe other tools. Counted, not listed. */
const PLUMBING = new Set([
  "discover_tools",
  "composio_search_tools",
  "composio_get_tool_schemas",
  "composio_search_skills",
  "composio_manage_skill",
  "get_current_date",
  "select_space",
  "set_active_tag",
  "who_am_i",
  "whoami",
  "list_spaces",
  "listspaces",
  "composio_submit_feedback",
]);

const COMPOSIO_SLUG = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;

// ------------------------------------------------------------------------------------------
// Entry point

export function interpretCalls(calls: ToolCall[]): InterpretedStep[] {
  // A gateway call (execute_tool) is followed, not always immediately (the agent runs tools
  // in parallel), by the real call it made. Each inner call is merged into the earliest
  // unclaimed gateway call that invoked it; the step keeps the gateway call's position.
  const merged = new Map<number, ToolCall>();
  const pending: { index: number; target: string; args: Record<string, unknown>; wrapper: ToolCall }[] = [];

  calls.forEach((call, index) => {
    if (call.name === "execute_tool" && isRecord(call.input) && typeof call.input.tool_name === "string") {
      const args = isRecord(call.input.arguments) ? call.input.arguments : {};
      pending.push({ index, target: call.input.tool_name, args, wrapper: call });
      merged.set(index, { name: call.input.tool_name, input: args, output: call.output, error: call.error });
      return;
    }
    const owner = pending.findIndex((p) => invokes(p.target, call));
    if (owner >= 0) {
      const [p] = pending.splice(owner, 1);
      merged.set(p.index, {
        name: call.name,
        input: isRecord(call.input) ? { ...p.args, ...call.input } : p.args,
        output: call.output ?? p.wrapper.output,
        error: call.error || p.wrapper.error,
      });
      return;
    }
    merged.set(index, call);
  });

  return [...merged.entries()].sort(([a], [b]) => a - b).map(([index, call]) => toStep(call, index));
}

function invokes(target: string, next: ToolCall): boolean {
  if (next.name === target) return true;
  if (next.name === "composio_multi_execute_tool" && isRecord(next.input) && Array.isArray(next.input.tools)) {
    return next.input.tools.some((t) => isRecord(t) && t.tool_slug === target);
  }
  return false;
}

function toStep(call: ToolCall, index: number): InterpretedStep {
  const input = isRecord(call.input) ? call.input : {};
  const result = call.output == null ? undefined : unwrapResult(call.output);
  // MCP results flag failures with isError rather than an error field.
  const mcpError = isRecord(call.output) && call.output.isError === true ? stringResult(call.output) || "The tool reported an error." : undefined;
  const interpretation = interpret(call.name, input, result);
  const envelope = composioEnvelope(result);
  const errorText =
    errorMessage(call.error) ??
    (mcpError ? errorMessage(mcpError) : undefined) ??
    (envelope && !envelope.successful ? errorMessage(envelope.error) ?? "The tool reported a failure." : undefined) ??
    interpretation.innerError;
  const status: ActivityStatus = errorText ? "failed" : call.output == null ? "running" : "done";

  // The agent's own plain-language description of this step, when it gave one.
  const narration = typeof input.current_step === "string" ? narrate(input.current_step) : undefined;
  const label =
    narration ??
    (status === "running"
      ? interpretation.labels.running
      : status === "failed"
        ? interpretation.labels.failed ?? `Couldn't finish: ${lower(interpretation.labels.running)}`
        : interpretation.labels.done);

  return {
    index,
    label,
    status,
    detail: errorText ? clip(errorText, 240) : undefined,
    app: interpretation.app,
    action: interpretation.action,
    preview: status === "running" && interpretation.preview?.type !== "code" ? undefined : interpretation.preview,
    hidden: interpretation.hidden,
    artifacts: status === "done" ? interpretation.artifacts : undefined,
  };
}

// ------------------------------------------------------------------------------------------
// Interpreters

function interpret(name: string, input: Record<string, unknown>, result: unknown): Interpretation {
  if (PLUMBING.has(name)) {
    return { labels: { running: "Finding the right tool", done: "Found the right tool" }, app: "agent", action: "other", hidden: true };
  }
  if (COMPOSIO_SLUG.test(name)) return composioTool(name, input, result);
  if (isKnownToolkit(name)) return composioTool(name.toUpperCase(), input, result);

  switch (name) {
    case "composio_multi_execute_tool":
      return multiExecute(input, result);
    case "composio_remote_workbench":
    case "composio_remote_bash_tool":
    case "python_repl":
    case "run_python":
      return code(name, input, result);
    case "composio_manage_connections":
    case "composio_wait_for_connections":
      return connections(name, input, result);
    case "search":
    case "web_search":
    case "exa_search":
    case "search_web":
      return webSearch(input, result);
    case "search_memory":
    case "list_memories":
    case "listmemories":
    case "get_profile":
    case "list_documents":
    case "listdocuments":
    case "get_document":
    case "getdocument":
      return memoryRead(result);
    case "add_memory":
    case "save_memory":
    case "guided_save":
      return memoryWrite(input);
    case "forget_memory":
      return { labels: { running: "Updating memory", done: "Updated memory" }, app: "memory", action: "remember" };
    case "start":
      return { labels: { running: "Opening a browser", done: "Opened a browser" }, app: "browser", action: "browse" };
    case "navigate":
      return navigate(input);
    case "extract":
    case "observe":
    case "act":
      return browserPage(name, result);
    case "evaluate_expression":
    case "calculator":
      return {
        labels: { running: "Calculating", done: "Calculated" },
        app: "calculator",
        action: "run",
        preview: typeof input.expression === "string" ? textPreview(`${input.expression} = ${stringResult(result)}`) : undefined,
      };
    case "load_skill":
      return { labels: { running: "Checking a playbook", done: "Checked a playbook" }, app: "agent", action: "read", hidden: true };
  }
  const words = humanize(name);
  return { labels: { running: `Using ${words}`, done: `Used ${words}` }, app: "agent", action: "other" };
}

function composioTool(slug: string, input: Record<string, unknown>, result: unknown): Interpretation {
  const app = appForToolkit(slug);
  const verb = verbFor(slug, app);
  const envelope = composioEnvelope(result);
  const data = envelope ? envelope.data : result;
  return {
    labels: verb.labels,
    app,
    action: verb.action,
    preview: previewFor(slug, app, input, data),
    artifacts: [artifactFor(slug, app, data)].filter((a): a is Artifact => !!a),
  };
}

function multiExecute(input: Record<string, unknown>, result: unknown): Interpretation {
  const tools = Array.isArray(input.tools) ? input.tools.filter(isRecord) : [];
  const envelope = composioEnvelope(result);
  const results = isRecord(envelope?.data) && Array.isArray(envelope.data.results) ? envelope.data.results.filter(isRecord) : [];
  const first = tools[0];
  if (!first || typeof first.tool_slug !== "string") {
    return { labels: { running: "Working in your apps", done: "Worked in your apps" }, app: "agent", action: "other" };
  }
  const response = results.find((r) => r.tool_slug === first.tool_slug) ?? results[0];
  const inner = response && isRecord(response.response) ? response.response : undefined;
  const interpretation = composioTool(first.tool_slug, isRecord(first.arguments) ? first.arguments : {}, inner);
  if (inner && inner.successful === false) interpretation.innerError = errorMessage(inner.error) ?? "The tool reported a failure.";
  if (tools.length > 1) {
    const apps = [...new Set(tools.map((t) => (typeof t.tool_slug === "string" ? appName(appForToolkit(t.tool_slug)) : null)).filter(Boolean))];
    const where = apps.length > 1 ? `${apps.slice(0, -1).join(", ")} and ${apps.at(-1)}` : apps[0];
    interpretation.labels = { running: `Working in ${where}`, done: `Worked in ${where}` };
  }
  return interpretation;
}

function code(name: string, input: Record<string, unknown>, result: unknown): Interpretation {
  const source = firstString(input, ["code_to_execute", "code", "command", "python_code"]);
  const envelope = composioEnvelope(result);
  const data = isRecord(envelope?.data) ? envelope.data : isRecord(result) ? result : {};
  const rawStdout = firstString(data, ["stdout", "output", "results"]);
  const stderr = firstString(data, ["stderr"]);
  const failure = firstString(data, ["error"]);
  const { steps, artifacts, rest } = readMarkers(rawStdout ?? "");
  const stdout = rest.trim();
  return {
    labels: { running: "Running an analysis", done: "Ran an analysis", failed: "The analysis hit an error" },
    app: "code",
    action: "run",
    preview: source
      ? {
          type: "code",
          language: name.includes("bash") ? "bash" : "python",
          code: clip(source, 4000),
          output: stdout ? clip(stdout, 2000) : undefined,
          steps: steps.length > 0 ? steps : undefined,
        }
      : undefined,
    artifacts,
    innerError: failure ? clip(failure, 400) : stderr && !stdout ? clip(stderr, 400) : undefined,
  };
}

function connections(name: string, input: Record<string, unknown>, result: unknown): Interpretation {
  const toolkits = Array.isArray(input.toolkits) ? input.toolkits.filter(isRecord) : [];
  const toolkit = toolkits.map((t) => firstString(t, ["name", "toolkit", "slug"])).find(Boolean);
  const app = toolkit ? appForToolkit(toolkit) : "agent";
  const where = toolkit ? appName(app) : "your apps";
  const envelope = composioEnvelope(result);
  const link = findUrl(envelope?.data, /redirect|connect|auth|link/i);
  if (name === "composio_wait_for_connections") {
    return { labels: { running: `Waiting for you to connect ${where}`, done: `${where} connected` }, app, action: "connect" };
  }
  return {
    labels: { running: `Checking your ${where} connection`, done: `Checked your ${where} connection` },
    app,
    action: "connect",
    preview: link ? { type: "link", url: link, title: `Connect ${where}` } : undefined,
  };
}

function webSearch(input: Record<string, unknown>, result: unknown): Interpretation {
  const query = typeof input.query === "string" ? clip(input.query, 80) : "";
  const label = query ? ` for “${query}”` : "";
  return {
    labels: { running: `Searching the web${label}`, done: `Searched the web${label}` },
    app: "web",
    action: "search",
    preview: sourcesPreview(result),
  };
}

function memoryRead(result: unknown): Interpretation {
  const text = stringResult(result);
  return {
    labels: { running: "Checking memory", done: "Checked memory" },
    app: "memory",
    action: "remember",
    preview: text ? textPreview(text) : undefined,
  };
}

function memoryWrite(input: Record<string, unknown>): Interpretation {
  const content = firstString(input, ["content", "memory", "text"]);
  return {
    labels: { running: "Saving to memory", done: "Saved to memory" },
    app: "memory",
    action: "remember",
    preview: content ? textPreview(content) : undefined,
  };
}

function navigate(input: Record<string, unknown>): Interpretation {
  const url = safeUrl(input.url);
  const where = url ? domainOf(url) : "a page";
  return {
    labels: { running: `Visiting ${where}`, done: `Visited ${where}`, failed: `Couldn't open ${where}` },
    app: "browser",
    action: "browse",
    preview: url ? { type: "link", url, title: where } : undefined,
  };
}

function browserPage(name: string, result: unknown): Interpretation {
  const labels =
    name === "extract"
      ? { running: "Reading the page", done: "Read the page" }
      : name === "observe"
        ? { running: "Looking at the page", done: "Looked at the page" }
        : { running: "Using the page", done: "Used the page" };
  const value = unwrapResult(result);
  const data = isRecord(value) && "data" in value ? value.data : value;
  const text = typeof data === "string" ? data : data != null ? JSON.stringify(data) : "";
  return { labels, app: "browser", action: "browse", preview: text ? textPreview(text) : undefined };
}

/**
 * Explicit progress markers printed by code the agent runs (see README, "Work markers"):
 *   STEP <plain-language progress>
 *   ARTIFACT {"id","kind","title","url","description"?,"source"?}
 * Only lines that start with these exact markers count; nothing else in the output is
 * interpreted. Artifacts are validated again (https only, known kinds) before display.
 */
export function readMarkers(output: string): { steps: string[]; artifacts: Artifact[]; rest: string } {
  const steps: string[] = [];
  const artifacts: Artifact[] = [];
  const rest: string[] = [];
  for (const line of output.split("\n")) {
    const step = /^STEP\s+(.+)$/.exec(line.trim());
    const artifact = /^ARTIFACT\s+(\{.*\})$/.exec(line.trim());
    if (step) {
      if (steps.length < 20) steps.push(clip(step[1], 160));
    } else if (artifact) {
      const value = maybeJson(artifact[1]);
      if (isRecord(value)) {
        const url = safeUrl(value.url);
        const title = firstString(value, ["title"]);
        if (url && title && artifacts.length < 5) {
          artifacts.push({
            id: clip(firstString(value, ["id"]) ?? url, 200),
            kind: (typeof value.kind === "string" ? value.kind : "file") as Artifact["kind"],
            title: clip(title, 200),
            description: firstString(value, ["description"]) ? clip(value.description, 300) : undefined,
            source: firstString(value, ["source"]) ? clip(value.source, 80) : undefined,
            url,
          });
        }
      }
    } else {
      rest.push(line);
    }
  }
  return { steps, artifacts, rest: rest.join("\n") };
}

// ------------------------------------------------------------------------------------------
// Composio verbs, previews, and artifacts

const VERBS: [RegExp, StepAction, (app: string) => { running: string; done: string }][] = [
  [/_(SEND|REPLY|FORWARD)/, "write", (a) => (a === "Gmail" || a === "Outlook" ? { running: "Sending an email", done: "Sent an email" } : { running: `Sending in ${a}`, done: `Sent in ${a}` })],
  [/_(CREATE_DRAFT|DRAFT)/, "write", () => ({ running: "Drafting an email", done: "Drafted an email" })],
  [/^GOOGLESHEETS_CREATE/, "write", () => ({ running: "Creating a spreadsheet", done: "Created a spreadsheet" })],
  [/^GOOGLEDOCS_CREATE/, "write", () => ({ running: "Creating a document", done: "Created a document" })],
  [/_(CREATE|ADD|INSERT)/, "write", (a) => ({ running: `Adding to ${a}`, done: `Added to ${a}` })],
  [/_(UPDATE|APPEND|BATCH|WRITE|SET|EDIT|MODIFY|MOVE)/, "write", (a) => ({ running: `Updating ${a}`, done: `Updated ${a}` })],
  [/_(DELETE|REMOVE|TRASH|ARCHIVE)/, "write", (a) => ({ running: `Removing from ${a}`, done: `Removed from ${a}` })],
  [/_(SEARCH|FIND|QUERY|LOOKUP)/, "search", (a) => ({ running: `Searching ${a}`, done: `Searched ${a}` })],
  [/_(FETCH|LIST|GET|READ|RETRIEVE|EXPORT|DOWNLOAD)/, "read", (a) => ({ running: `Checking ${a}`, done: `Checked ${a}` })],
];

function verbFor(slug: string, app: AppId): { labels: { running: string; done: string }; action: StepAction } {
  const name = appName(app);
  for (const [pattern, action, labels] of VERBS) if (pattern.test(slug)) return { labels: labels(name), action };
  return { labels: { running: `Working in ${name}`, done: `Worked in ${name}` }, action: "other" };
}

function previewFor(slug: string, app: AppId, input: Record<string, unknown>, data: unknown): StepPreview | undefined {
  // Rows the agent wrote: shown exactly as sent.
  const values = input.values ?? (isRecord(input.data) ? input.data.values : undefined);
  if (Array.isArray(values) && values.every(Array.isArray)) return tablePreview(values as unknown[][], firstString(input, ["range", "sheet_name"]));

  if (app === "gmail" || app === "outlook") {
    const messages = findArray(data, ["messages", "emails", "value"]);
    if (messages) {
      const items = messages.filter(isRecord).map((m) => ({
        primary: clip(firstString(m, ["subject", "Subject"]) ?? "(no subject)", 120),
        secondary: clip(firstString(m, ["sender", "from", "From"]) ?? "", 80) || undefined,
        url: safeUrl(m.display_url ?? m.webLink),
      }));
      const { items: shown, total } = capList(items, MAX_ITEMS);
      return { type: "items", items: shown, total };
    }
    if (/_(SEND|REPLY|DRAFT)/.test(slug)) {
      const to = firstString(input, ["recipient_email", "to", "recipient"]);
      const subject = firstString(input, ["subject"]);
      if (to || subject) return { type: "items", items: [{ primary: clip(subject ?? "(no subject)", 120), secondary: to ? `To ${clip(to, 80)}` : undefined }] };
    }
  }

  // Generic lists of records (orders, products, events, files…).
  const list = findArray(data, ["items", "results", "records", "rows", "orders", "products", "events", "files", "data"]);
  if (list && list.length > 0 && list.every(isRecord)) {
    const items = (list as Record<string, unknown>[]).map((r) => ({
      primary: clip(firstString(r, ["title", "name", "subject", "summary", "id"]) ?? "Item", 120),
      secondary: clip(firstString(r, ["status", "email", "created_at", "date", "updated_at"]) ?? "", 80) || undefined,
      url: safeUrl(r.url ?? r.webViewLink ?? r.htmlLink),
    }));
    const { items: shown, total } = capList(items, MAX_ITEMS);
    return { type: "items", items: shown, total };
  }
  const sheetValues = findArray(data, ["values"]);
  if (sheetValues && sheetValues.every(Array.isArray)) return tablePreview(sheetValues as unknown[][]);
  return undefined;
}

/** Files the agent created, from the create call's own structured result. */
function artifactFor(slug: string, app: AppId, data: unknown): Artifact | undefined {
  if (!/_CREATE/.test(slug)) return undefined;
  const kind = app === "sheets" ? "spreadsheet" : app === "docs" ? "document" : app === "drive" ? "file" : undefined;
  if (!kind) return undefined;
  const url = findUrl(data, /url|link/i);
  if (!url) return undefined;
  const record = isRecord(data) ? data : {};
  const props = isRecord(record.properties) ? record.properties : {};
  const title = firstString(props, ["title"]) ?? firstString(record, ["title", "name"]) ?? (kind === "spreadsheet" ? "New spreadsheet" : "New document");
  const id = firstString(record, ["spreadsheetId", "documentId", "id"]) ?? url;
  return { id, kind, title: clip(title, 200), source: appName(app), url };
}

// ------------------------------------------------------------------------------------------
// Preview builders

function sourcesPreview(result: unknown): StepPreview | undefined {
  const value = unwrapResult(result);
  let entries: { title: string; url: string }[] = [];
  if (isRecord(value) && Array.isArray(value.results)) {
    entries = value.results.filter(isRecord).flatMap((r) => {
      const url = safeUrl(r.url);
      return url ? [{ title: clip(firstString(r, ["title"]) ?? domainOf(url), 140), url }] : [];
    });
  } else if (typeof value === "string") {
    // Text form: repeated "Title: …\nURL: …" blocks.
    const pattern = /Title:\s*(.*)\n\s*URL:\s*(\S+)/g;
    for (const match of value.matchAll(pattern)) {
      const url = safeUrl(match[2]);
      if (url) entries.push({ title: clip(match[1] || domainOf(url), 140), url });
    }
  }
  if (entries.length === 0) return undefined;
  const unique = [...new Map(entries.map((e) => [e.url, e])).values()];
  const { items, total } = capList(unique.map((e) => ({ ...e, domain: domainOf(e.url) })), MAX_ITEMS);
  return { type: "sources", items, total };
}

function tablePreview(values: unknown[][], title?: string): StepPreview | undefined {
  const rows = values.map((row) => row.map((cell) => clip(cell ?? "", 80)));
  if (rows.length === 0) return undefined;
  const [header, ...body] = rows;
  const width = Math.min(12, Math.max(...rows.map((r) => r.length)));
  const columns = header.slice(0, width);
  const { items, total } = capList(body.map((r) => r.slice(0, width)), MAX_ROWS);
  return { type: "table", columns, rows: items, total, title: title ? clip(title, 80) : undefined };
}

function textPreview(text: string): StepPreview {
  return { type: "text", text: clip(text, 1200) };
}

function stringResult(result: unknown): string {
  const value = unwrapResult(result);
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.result === "string") return value.result;
  return value == null ? "" : JSON.stringify(value);
}

// ------------------------------------------------------------------------------------------
// Utilities

function findArray(data: unknown, keys: string[], depth = 0): unknown[] | undefined {
  const value = maybeJson(data);
  if (Array.isArray(value)) return depth === 0 ? undefined : value;
  if (!isRecord(value) || depth > 3) return undefined;
  for (const key of keys) if (Array.isArray(value[key])) return value[key] as unknown[];
  for (const nested of Object.values(value)) {
    if (isRecord(nested)) {
      const found = findArray(nested, keys, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function findUrl(data: unknown, keyPattern: RegExp, depth = 0): string | undefined {
  const value = maybeJson(data);
  if (!isRecord(value) || depth > 3) return undefined;
  for (const [key, nested] of Object.entries(value)) {
    if (keyPattern.test(key)) {
      const url = safeUrl(nested);
      if (url) return url;
    }
  }
  for (const nested of Object.values(value)) {
    const url = findUrl(nested, keyPattern, depth + 1);
    if (url) return url;
  }
  return undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (value == null || value === false || value === "") return undefined;
  if (typeof value === "string") {
    // e.g. "MCP tool 'X' failed: {\"successful\": false, \"error\": \"…\"}" → the inner reason.
    const brace = value.indexOf("{");
    if (brace >= 0) {
      const inner = maybeJson(value.slice(brace));
      if (isRecord(inner)) {
        const data = isRecord(inner.data) ? inner.data : {};
        const reason = firstString(inner, ["error", "message", "detail"]) ?? firstString(data, ["error", "stderr", "message"]);
        if (reason) return reason;
      }
    }
    return value;
  }
  if (isRecord(value)) return firstString(value, ["message", "error", "detail"]) ?? JSON.stringify(value);
  return String(value);
}

function humanize(name: string): string {
  return (
    name
      .replace(/^composio_/, "")
      .replace(/[_-]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .trim()
      .toLowerCase() || "a tool"
  );
}

/**
 * The agent's step narration. It sometimes arrives as a status code ("FETCHING_EMAILS",
 * "READ_HEADERS"); those become sentence case. Natural sentences are kept as written.
 */
export function narrate(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  if (/^[A-Z0-9_ -]+$/.test(text) && /[A-Z]/.test(text)) {
    const words = text.replace(/[_-]+/g, " ").trim().toLowerCase();
    return clip(words.charAt(0).toUpperCase() + words.slice(1), 120);
  }
  return clip(text, 120);
}

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

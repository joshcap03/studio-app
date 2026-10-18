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
  splitSample,
  unwrapResult,
} from "./sanitize";

// Tool interpretation: turns raw tool calls into steps a non-technical person can follow, in plain
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
    // take_action is the same gateway call for actions that needed the owner's approval.
    if (GATEWAY_TOOLS.has(call.name) && isRecord(call.input) && typeof call.input.tool_name === "string") {
      const args = isRecord(call.input.arguments) ? call.input.arguments : {};
      pending.push({ index, target: call.input.tool_name, args, wrapper: call });
      merged.set(index, { name: call.input.tool_name, input: args, output: call.output, error: call.error });
      return;
    }
    // Match by content first: the gateway passes its arguments straight through, so the
    // inner call's input equals the gateway call's arguments. Then by exact tool name, then
    // by a Composio slug the multi-execute ran. A gateway call it turned away invoked nothing;
    // one that reports the tool failed did run it.
    const live = (p: (typeof pending)[number]) => {
      const out = p.wrapper.output == null ? undefined : unwrapResult(p.wrapper.output);
      return !(typeof out === "string" && REJECTED_BY_GATEWAY.test(out.trim()));
    };
    const inputKey = stableJson(call.input);
    let owner = pending.findIndex((p) => live(p) && p.target === call.name && stableJson(p.args) === inputKey);
    if (owner < 0) owner = pending.findIndex((p) => live(p) && p.target === call.name);
    if (owner < 0) owner = pending.findIndex((p) => live(p) && invokes(p.target, call));
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

function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : isRecord(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(value ?? {}));
}

/** The gateway refused the call before running anything. */
const REJECTED_BY_GATEWAY = /^"?(Unknown tool '|Invalid arguments for|Tool arguments must be|Approvals aren't available in this run)/;

/** The gateway's own tools, which a person should never see named. */
const GATEWAY_TOOLS = new Set(["execute_tool", "take_action", "discover_tools"]);

function invokes(target: string, next: ToolCall): boolean {
  if (next.name === target) return true;
  if (next.name === "composio_multi_execute_tool" && isRecord(next.input) && Array.isArray(next.input.tools)) {
    return next.input.tools.some((t) => isRecord(t) && t.tool_slug === target);
  }
  return false;
}

function toStep(original: ToolCall, index: number): InterpretedStep {
  const call = original.name === "composio_multi_execute_tool" ? keepWhatWorked(original) : original;
  const input = isRecord(call.input) ? call.input : {};
  const result = call.output == null ? undefined : unwrapResult(call.output);
  // MCP results flag failures with isError rather than an error field.
  const mcpError = isRecord(call.output) && call.output.isError === true ? stringResult(call.output) || "The tool reported an error." : undefined;
  // Tool gateways report failures as text results ("Tool X failed: …", "Tool X timed out …").
  const gatewayError = typeof result === "string" ? gatewayFailure(result) : undefined;
  const interpretation = interpret(call.name, input, result);
  if (typeof result === "string" && NEEDS_APPROVAL.test(result.trim())) {
    return { index, label: withoutRepeats(interpretation.labels.running), status: "done", app: interpretation.app, action: interpretation.action, hidden: true };
  }
  const envelope = composioEnvelope(result);
  const errorText =
    (errorMessage(call.error) ? humanReason(errorMessage(call.error)!) : undefined) ??
    (mcpError ? errorMessage(mcpError) : undefined) ??
    gatewayError ??
    (envelope && !envelope.successful ? errorMessage(envelope.error) ?? "The tool reported a failure." : undefined) ??
    interpretation.innerError;
  const status: ActivityStatus = errorText ? "failed" : call.output == null ? "running" : "done";

  // The agent's own plain-language description of this step, when it gave one.
  const narration = typeof input.current_step === "string" ? narrate(input.current_step) : undefined;
  const label = withoutRepeats(
    narration ??
    (status === "running"
      ? interpretation.labels.running
      : status === "failed"
        ? interpretation.labels.failed ?? `${interpretation.labels.running} didn't work`
        : interpretation.labels.done),
  );

  return {
    index,
    label,
    status,
    detail: errorText ? clip(errorText, 240) : undefined,
    app: interpretation.app,
    action: interpretation.action,
    preview: status === "running" && interpretation.preview?.type !== "code" ? undefined : interpretation.preview,
    // Plumbing is hidden only while it works; a failure is always shown.
    hidden: interpretation.hidden && status !== "failed" ? true : undefined,
    artifacts: status === "done" ? interpretation.artifacts : undefined,
  };
}

/**
 * Composio fails a whole batch when any one tool in it fails, but the failure still carries
 * every tool's result. Keeps the ones that worked, so what they found is shown (and their
 * links count), and drops tools that failed only because their app isn't connected: the
 * agent says so in its answer, and nothing went wrong.
 */
function keepWhatWorked(call: ToolCall): ToolCall {
  const texts = [call.error, call.output == null ? undefined : unwrapResult(call.output)];
  for (const text of texts) {
    if (typeof text !== "string" || !text.includes("{")) continue;
    const envelope = composioEnvelope(maybeJson(text.slice(text.indexOf("{"))));
    const data = isRecord(envelope?.data) ? envelope.data : undefined;
    if (!envelope || envelope.successful || !data || !Array.isArray(data.results)) continue;
    const results = data.results.filter(isRecord);
    const errorOf = (r: Record<string, unknown>) =>
      typeof r.error === "string" ? r.error : isRecord(r.response) && r.response.successful === false ? errorMessage(r.response.error) ?? "The tool reported a failure." : undefined;
    const kept = results.filter((r) => !NOT_CONNECTED.test(errorOf(r) ?? ""));
    // Every tool needed an app that isn't connected: say which, plainly.
    if (kept.length === 0) return { ...call, output: null, error: errorOf(results[0]) ?? call.error };
    const slugs = new Set(kept.map((r) => r.tool_slug));
    const input = isRecord(call.input) && Array.isArray(call.input.tools)
      ? { ...call.input, tools: call.input.tools.filter((t) => !isRecord(t) || slugs.has(t.tool_slug)) }
      : call.input;
    const failure = kept.map(errorOf).find(Boolean);
    return { ...call, input, output: { successful: !failure, data: { ...data, results: kept }, error: failure ?? null }, error: null };
  }
  return call;
}

const NOT_CONNECTED = /no active connection found for toolkit/i;

// ------------------------------------------------------------------------------------------
// Interpreters

function interpret(name: string, input: Record<string, unknown>, result: unknown): Interpretation {
  if (GATEWAY_TOOLS.has(name)) {
    // Shown on the status line while it runs, so it reads as the work, never the plumbing.
    return { labels: { running: "Working on it", done: "Worked on it", failed: "A step didn't go through" }, app: "agent", action: "other", hidden: true };
  }
  if (PLUMBING.has(name)) {
    return {
      labels: { running: "Figuring out how to do this", done: "Figured out how to do this", failed: "Couldn't figure out how to do this" },
      app: "agent",
      action: "other",
      hidden: true,
    };
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
    case "get_contents":
    case "exa_get_contents":
    case "crawling":
    case "crawling_exa":
      return webRead(input, result);
    case "search_memory":
    case "list_memories":
    case "listmemories":
    case "get_profile":
    case "list_documents":
    case "listdocuments":
    case "get_document":
    case "getdocument":
      return memoryRead(input, result);
    case "add_memory":
    case "save_memory":
    case "guided_save":
      return memoryWrite(input);
    case "forget_memory":
      return { labels: { running: "Updating memory", done: "Updated memory" }, app: "memory", action: "remember" };
    case "start":
      return browserStart(result);
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
    case "report_timeline":
      // Shown as the Timeline in Results, not as a step.
      return { labels: { running: "Putting the timeline together", done: "Put the timeline together" }, app: "agent", action: "note", hidden: true };
    case "cite":
      // Shown as numbered citations in the answer, not as a step.
      return { labels: { running: "Checking sources", done: "Checked sources" }, app: "agent", action: "note", hidden: true };
    case "report_visual":
      // Drawn in Results next to the timeline, not shown as a step.
      return { labels: { running: "Drawing a chart", done: "Drew a chart" }, app: "agent", action: "note", hidden: true };
    case "ask_user":
      // The questions are shown under the reply as choices to click.
      return { labels: { running: "Writing a question for you", done: "Asked you a question" }, app: "agent", action: "note", hidden: true };
    case "show_form":
      // The form is shown under the reply for the member to fill in.
      return { labels: { running: "Putting a short form together", done: "Asked you a few things" }, app: "agent", action: "note", hidden: true };
    case "propose_agent":
      // The proposal is shown under the reply; nothing changes until the member applies it.
      return { labels: { running: "Drafting how I'll work for you", done: "Suggested how I'll work for you" }, app: "agent", action: "note", hidden: true };
    case "report_run":
      // Decides whether the member is notified; the reply itself says how it went.
      return { labels: { running: "Wrapping up", done: "Wrapped up" }, app: "agent", action: "note", hidden: true };
    case "update_plan":
      return planUpdate(input);
    case "save_record":
      return recordSave(input);
    case "remember":
    case "propose_memory":
      // What was remembered is shown on its own line under the reply, with an Undo.
      return { labels: { running: "Noting something to remember", done: "Remembered something" }, app: "memory", action: "remember", hidden: true };
  }
  // Any other tool that sends back a list of web results ({ url, title, text }) read the web.
  if (sourcesPreview(result) && isRecord(unwrapResult(result))) return webRead(input, result);
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
    preview: withQuery(previewFor(slug, app, input, data) ?? readablePreview(data), input),
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
  // With several tools, show the first one that returned something readable.
  if (!interpretation.preview) {
    for (const tool of tools.slice(1)) {
      if (typeof tool.tool_slug !== "string") continue;
      const r = results.find((x) => x.tool_slug === tool.tool_slug);
      const other = composioTool(tool.tool_slug, isRecord(tool.arguments) ? tool.arguments : {}, r && isRecord(r.response) ? r.response : undefined);
      if (other.preview) {
        interpretation.preview = other.preview;
        interpretation.app = other.app;
        break;
      }
    }
  }
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
    labels: { running: "Working through the data", done: "Worked through the data", failed: "Hit an error working through the data" },
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
  // Composio takes toolkits as plain names (["gmail"]) or as records ({ name: "gmail", … }).
  const toolkits = (Array.isArray(input.toolkits) ? input.toolkits : [])
    .map((t) => (typeof t === "string" ? t.trim() : isRecord(t) ? firstString(t, ["name", "toolkit", "slug"]) : undefined))
    .filter((t): t is string => !!t);
  const apps = [...new Set(toolkits.map((t) => appForToolkit(t)))];
  const app: AppId = apps.length === 1 ? apps[0] : "agent";
  const names = apps.map((a) => appName(a));
  const where = names.length === 0 ? undefined : names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const envelope = composioEnvelope(result);
  const link = findUrl(envelope?.data, /redirect|connect|auth|link/i);
  if (name === "composio_wait_for_connections") {
    return {
      labels: where
        ? { running: `Waiting for you to connect ${where}`, done: `${where} connected`, failed: `Couldn't confirm ${where} is connected` }
        : { running: "Waiting for you to connect your apps", done: "Your apps are connected", failed: "Couldn't confirm your apps are connected" },
      app,
      action: "connect",
    };
  }
  return {
    labels: where
      ? { running: `Connecting ${where}`, done: link ? `Got a link to connect ${where}` : `Checked the ${where} connection${names.length > 1 ? "s" : ""}`, failed: `Couldn't connect ${where}` }
      : { running: "Checking your app connections", done: link ? "Got a link to connect your apps" : "Checked your app connections", failed: "Couldn't check your app connections" },
    app,
    action: "connect",
    preview: link ? { type: "link", url: link, title: where ? `Connect ${where}` : "Connect your apps" } : undefined,
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

/** Reading pages by link (e.g. Exa's get_contents): named by the site, or how many pages. */
function webRead(input: Record<string, unknown>, result: unknown): Interpretation {
  const asked = ["ids", "urls", "url", "id"].flatMap((k) => (Array.isArray(input[k]) ? input[k] : [input[k]])).map(safeUrl).filter((u): u is string => !!u);
  const preview = sourcesPreview(result);
  const urls = asked.length > 0 ? asked : preview?.type === "sources" ? preview.items.map((i) => i.url) : [];
  const domains = [...new Set(urls.map(domainOf))];
  const what = domains.length === 1 ? domains[0] : urls.length > 1 ? `${urls.length} pages` : "a page";
  return {
    labels: { running: `Reading ${what}`, done: `Read ${what}`, failed: `Couldn't read ${what}` },
    app: "web",
    action: "read",
    preview,
  };
}

function memoryRead(input: Record<string, unknown>, result: unknown): Interpretation {
  const query = firstString(input, ["query", "q", "search"]);
  const about = query ? `“${clip(query, 60)}”` : "you";
  return {
    labels: { running: `Checking what I know about ${about}`, done: `Checked what I know about ${about}` },
    app: "memory",
    action: "remember",
    preview: withQuery(readablePreview(result) ?? (query ? { type: "items", items: [], total: 0 } : undefined), { query }),
  };
}

function memoryWrite(input: Record<string, unknown>): Interpretation {
  const content = firstString(input, ["content", "memory", "text"]);
  return {
    labels: { running: "Noting this for next time", done: "Noted this for next time" },
    app: "memory",
    action: "remember",
    preview: content ? readablePreview(content) : undefined,
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

/**
 * Starting a browser session returns only its connection details (a session id and a signed
 * remote-debugging URL), never page content, so it is plumbing: shown while it runs, hidden
 * once it works, and shown with a reason if the session didn't start.
 */
function browserStart(result: unknown): Interpretation {
  const value = unwrapResult(result);
  const failed = isRecord(value) && (value.success === false || (isRecord(value.data) && value.data.available === false));
  return {
    labels: { running: "Opening a browser", done: "Opened a browser", failed: "Couldn't open a browser" },
    app: "browser",
    action: "browse",
    hidden: true,
    innerError: failed ? (isRecord(value) && errorMessage(value.error)) || "The browser wasn't available." : undefined,
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
  return { labels, app: "browser", action: "browse", preview: readablePreview(data) };
}

/**
 * Explicit progress markers printed by code the agent runs (see docs/development.md, "Work markers"):
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
    const found = findArray(data, ["messages", "emails", "value"]);
    if (found) {
      const { entries: messages, omitted } = splitSample(found);
      const items = messages.filter(isRecord).map((m) => ({
        primary: clip(firstString(m, ["subject", "Subject"]) ?? "(no subject)", 120),
        secondary: clip(firstString(m, ["sender", "from", "From"]) ?? "", 80) || undefined,
        url: safeUrl(m.display_url ?? m.webLink),
      }));
      const { items: shown, total } = capList(items, MAX_ITEMS, omitted);
      return { type: "items", items: shown, total };
    }
    if (/_(SEND|REPLY|DRAFT)/.test(slug)) {
      const to = firstString(input, ["recipient_email", "to", "recipient"]);
      const subject = firstString(input, ["subject"]);
      if (to || subject) return { type: "items", items: [{ primary: clip(subject ?? "(no subject)", 120), secondary: to ? `To ${clip(to, 80)}` : undefined }] };
    }
  }

  // Generic lists of records (orders, products, events, files…).
  const { entries: list, omitted } = splitSample(findArray(data, LIST_KEYS) ?? []);
  if (list.length > 0 && list.every(isRecord)) {
    const items = (list as Record<string, unknown>[]).map((r) => ({
      primary: clip(firstString(r, ["title", "name", "subject", "summary", "id"]) ?? "Item", 120),
      secondary: clip(firstString(r, ["summary", "snippet", "description", "status", "email", "date", "created_at", "updated_at"]) ?? "", 160) || undefined,
      url: safeUrl(r.url ?? r.webViewLink ?? r.htmlLink),
    }));
    const { items: shown, total } = capList(items, MAX_ITEMS, omitted);
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

/** The agent rewrote its task's plan: shown with how far along it is (the plan itself is on the task). */
function planUpdate(input: Record<string, unknown>): Interpretation {
  const steps = Array.isArray(input.steps) ? input.steps.filter(isRecord) : [];
  const done = steps.filter((s) => s.status === "done").length;
  const next = steps.find((s) => s.status === "doing" || s.status === "todo" || s.status === "needs_you");
  const nextText = next && typeof next.text === "string" ? `; next: ${clip(next.text, 80)}` : "";
  return {
    labels: { running: "Updating the plan", done: "Updated the plan" },
    app: "tracker",
    action: "write",
    preview: steps.length > 0 ? textPreview(`Plan: ${done} of ${steps.length} ${steps.length === 1 ? "step" : "steps"} done${nextText}`) : undefined,
  };
}

/** The agent added or updated a row in the member's tracker. */
function recordSave(input: Record<string, unknown>): Interpretation {
  const title = firstString(input, ["title", "key"]);
  const status = firstString(input, ["status"]);
  const what = title ? `“${clip(title, 60)}”` : "an item";
  return {
    labels: { running: `Tracking ${what}`, done: `Tracked ${what}` },
    app: "tracker",
    action: "write",
    preview: title ? textPreview(`Tracked ${what}${status ? ` (${clip(status, 30)})` : ""}`) : undefined,
  };
}

function textPreview(text: string): StepPreview {
  return { type: "text", text: clip(text, 1200) };
}

/** Attaches what the tool was asked (its query) to list and text receipts. */
function withQuery(preview: StepPreview | undefined, input: Record<string, unknown>): StepPreview | undefined {
  const query = firstString(input, ["query", "q", "search", "keyword", "question", "search_query"]);
  if (!preview || !query || (preview.type !== "text" && preview.type !== "items")) return preview;
  return { ...preview, query: clip(query, 80) };
}

/** Keys under which apps commonly return lists of records. */
const LIST_KEYS = [
  "items", "results", "records", "rows", "orders", "products", "events", "files", "notes", "meetings",
  "documents", "memories", "threads", "contacts", "customers", "entries", "facts", "static", "dynamic", "data",
];

const TITLE_KEYS = ["title", "name", "subject", "label", "key"];
const BODY_KEYS = ["summary", "content", "memory", "text", "description", "value", "snippet", "answer", "result", "response", "output", "data"];

/**
 * A human-readable receipt for an arbitrary tool result, or nothing. Raw data is never
 * shown: JSON becomes a list of titles and summaries when it has them, plain strings stay
 * as text, and anything else is omitted.
 */
export function readablePreview(result: unknown): StepPreview | undefined {
  const value = unwrapResult(result);
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || /^[[{]/.test(text)) return undefined; // unparseable JSON-ish text: omit
    return textPreview(text);
  }
  const found = Array.isArray(value) ? value : findArray(value, LIST_KEYS);
  const { entries: list, omitted } = found ? splitSample(found) : { entries: undefined, omitted: 0 };
  if (list && list.length === 0 && omitted === 0) return { type: "items", items: [], total: 0 };
  if (list && list.length > 0) {
    const items = list.flatMap((entry) => {
      if (typeof entry === "string") return entry.trim() && !/^[[{]/.test(entry.trim()) ? [{ primary: clip(entry, 160) }] : [];
      if (!isRecord(entry)) return [];
      const title = firstString(entry, TITLE_KEYS);
      const body = firstString(entry, BODY_KEYS);
      if (!title && !body) return [];
      return [{ primary: clip(title ?? body!, 120), secondary: title && body ? clip(body, 220) : undefined }];
    });
    if (items.length === 0) return undefined;
    const { items: shown, total } = capList(items, MAX_ITEMS, omitted);
    return { type: "items", items: shown, total };
  }
  if (isRecord(value)) {
    const body = firstString(value, BODY_KEYS);
    if (body && !/^[[{]/.test(body.trim())) return textPreview(body);
    // Any other natural-language field, e.g. { extraction: "…" }.
    const prose = Object.values(value).find(
      (v): v is string => typeof v === "string" && v.trim().length > 20 && /\s/.test(v) && !/^[[{]/.test(v.trim()) && !/^https?:\/\//.test(v.trim()),
    );
    if (prose) return textPreview(prose);
    // One level down: { data: { result: … } }, { result: [ … ] }.
    for (const key of BODY_KEYS) {
      const nested = value[key];
      if (isRecord(nested) || Array.isArray(nested)) {
        const inner = readablePreview(nested);
        if (inner) return inner;
      }
    }
  }
  return undefined;
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
 * True when the agent's progress line talks about its machinery ("The search tool isn't
 * callable…") instead of the work. Such lines are kept but never shown while it works.
 * Quoted text (a job titled “Product Manager (Discovery)”) is the member's content, not
 * machinery talk, and "discovery" alone is a sales and product word; only tool discovery counts.
 */
export function talksMachinery(text: string): boolean {
  const own = text.replace(/“[^”]*”|"[^"]*"/g, " ");
  return /\b(tools?|tool calls?|toolkits?|schemas?|callable|composio|mcp|discover_tools)\b/i.test(own);
}

/** Tools that report on the answer (its sources, charts, questions, what to remember) rather than do the work. */
const REPORTING_TOOLS = new Set(["cite", "report_timeline", "report_visual", "ask_user", "show_form", "propose_agent", "remember", "propose_memory"]);

/**
 * Whether a call only reports on the answer. Text the agent writes before such a call is
 * the answer itself (agents often answer, then cite or remember), never an opening line.
 */
export function reportsOnAnswer(name: string, input: unknown): boolean {
  if (REPORTING_TOOLS.has(name)) return true;
  return GATEWAY_TOOLS.has(name) && isRecord(input) && typeof input.tool_name === "string" && REPORTING_TOOLS.has(input.tool_name);
}

/** Calls that only keep the agent's own books (its plan, a task run's outcome) and do no work. */
const BOOKKEEPING_TOOLS = new Set(["update_plan", "report_run"]);

/**
 * Whether a call says or does nothing the member waits on. A run that ends with only such calls
 * after a line of text meant that line as its reply, not as an opening line.
 */
export function keepsBooks(name: string, input: unknown): boolean {
  if (reportsOnAnswer(name, input) || BOOKKEEPING_TOOLS.has(name)) return true;
  return GATEWAY_TOOLS.has(name) && isRecord(input) && typeof input.tool_name === "string" && BOOKKEEPING_TOOLS.has(input.tool_name);
}

/** Longest text treated as an opening line ("Let me check your emails") rather than the answer. */
export const OPENING_LINE_MAX = 280;

/** Whether text the agent wrote before a tool call reads as an opening line: short, one paragraph. */
export function opensWork(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= OPENING_LINE_MAX && !trimmed.includes("\n\n");
}

/** A gateway's plain-text failure report, reduced to the reason a person needs. */
export function gatewayFailure(text: string): string | undefined {
  const value = text.trim().replace(/^"|"$/g, "");
  const failed = /^Tool \S+ failed: (?:\w+: )?([\s\S]*?)(?:\. Do not blindly retry writes\.)?\s*$/.exec(value);
  if (failed) return humanReason(errorMessage(failed[1]) ?? failed[1]);
  const timedOut = /^Tool \S+ timed out after (\d+)s/.exec(value);
  if (timedOut) return `The service didn't respond within ${timedOut[1]} seconds.`;
  const unknown = /^Unknown tool '([^']+)'/.exec(value);
  if (unknown && GATEWAY_TOOLS.has(unknown[1])) return "Called its tool runner the wrong way.";
  if (unknown) return `Asked for a tool called “${humanize(unknown[1])}”, which doesn't exist here.`;
  if (/^(Invalid arguments for|Tool arguments must be)/.test(value)) return "Sent the tool the wrong details.";
  if (/^Approvals aren't available in this run/.test(value)) return "Couldn't ask for your approval here, so nothing was changed.";
  return undefined;
}

/** The gateway turned a change away until it goes through approval; the next call asks. */
const NEEDS_APPROVAL = /^"?This changes something in the owner's accounts, so it needs their approval\./;

/** Common technical failure reasons in plain words; anything else passes through, trimmed. */
export function humanReason(raw: string): string {
  const reason = raw
    .replace(/^MCP tool '[^']+' failed:\s*/i, "")
    .replace(/\s*[{[][\s\S]*$/, "")
    .replace(/^(\w*(Error|Exception)):\s*/i, "")
    .trim();
  const missing = /no active connection found for toolkit\(?s?\)? '([^']+)'/i.exec(reason);
  if (missing) return `${appName(appForToolkit(missing[1]))} isn't connected.`;
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|not authenticated|invalid (api )?key|expired token/i.test(reason)) {
    return "The app isn't connected or needs to be re-authorized.";
  }
  if (/\b429\b|rate.?limit|too many requests/i.test(reason)) return "The app is rate-limiting requests right now.";
  if (/\b404\b|not found/i.test(reason)) return "It couldn't find what it was looking for.";
  if (/timed? ?out|timeout/i.test(reason)) return "The app took too long to respond.";
  if (/\b5\d\d\b|internal server error|service unavailable|bad gateway/i.test(reason)) return "The app had a temporary problem.";
  if (/no active session|session (closed|expired)/i.test(reason)) return "The browser session had closed.";
  if (/\d+ out of \d+ tools failed/i.test(reason)) return "The app couldn't complete those requests.";
  if (/is required|missing (required )?(field|argument|parameter)/i.test(reason)) return "The tool was missing some details it needed.";
  // Anything that still reads like code or a stack trace gets a plain fallback.
  if (!reason || /['"`{}()<>\[\]]|_[a-z]|[a-z]_|object has no attribute|traceback|undefined|null\b|nonetype|\.py\b/i.test(reason)) {
    return "Something went wrong on the app's side.";
  }
  return clip(reason, 200);
}

/**
 * Collapses an accidentally repeated word ("Checking your your apps") left by a template
 * filled with a phrase that already carries it. Applied to every label.
 */
export function withoutRepeats(label: string): string {
  // Quoted text (a search query, a page title) is the user's or the source's own words: kept.
  return label
    .split(/(“[^”]*”)/)
    .map((part) => (part.startsWith("“") ? part : part.replace(/\b([\p{L}']+)(\s+\1\b)+/giu, "$1")))
    .join("");
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


export { evidenceFor, evidenceLinks, type Evidence } from "./evidence";

import { appForToolkit } from "@/lib/apps";
import { toMemoryCategory } from "@/lib/types";
import { interpretCalls, type ToolCall } from "./tools";
import { clip, isRecord, maybeJson, unwrapResult } from "./tools/sanitize";
import { AgentError, type AgentAdapter, type AgentEvent, type AgentRunInput, type AgentTenantContext } from "./types";

// Langflow adapter. Everything Langflow-specific lives in this file.
//
// Contract (verified against Langflow 1.12.4 and its source, against a live server):
//   POST {base}/api/v2/workflows   header x-api-key
//     body { flow_id, input_value, session_id, tweaks, mode: "background", stream_protocol: "langflow" }
//     → { job_id, status: "queued" }
//   GET  {base}/api/v2/workflows/{job_id}/events   [Last-Event-ID]
//     text/event-stream; each frame is "data: <json>" plus an "id: <n>" line, frames separated
//     by a blank line. JSON is { event, data } with the same events as the v1 stream:
//     token.data.chunk (incremental text), add_message (a Message; sender "Machine" for the
//     bot; content_blocks hold tool calls { type: "tool_use", name, tool_input, output, error }),
//     remove_message (a partial bubble retracted), error.data.error, end. A run that pauses
//     for approval sends human_input_required { request_id, kind: "tool_approval",
//     action_requests: [{ name, args }] } and the stream closes with the job "suspended".
//   POST {base}/api/v2/workflows/{job_id}/resume   { request_id, decision: { action_id, values } }
//     → 404 unknown job, 409 not suspended/stale; then the job continues and its events are
//     read again from the last event id.
//   POST {base}/api/v2/workflows/stop  { job_id } cancels a running or suspended job.
//   POST {base}/api/v2/files (multipart "file") → { path } usable in ChatInput.files.
//   GET/DELETE {base}/api/v1/monitor/messages: the flow's stored chat memory per session.
//   Approvals come from the Agent's tool-approval middleware: tools whose metadata carries
//   approval_actions (the Studio Tool Gateway's take_action) pause before running.
//   Per-request global variables: X-LANGFLOW-GLOBAL-VAR-{NAME} headers.
//   Optional trusted end-user header (LANGFLOW_SERVING_END_USER_HEADER on the Langflow
//   server) scopes Langflow's own chat memory to "<end_user>::<session_id>".
//
// Tenant isolation does not rely on the flow: this adapter derives the session id from the
// workspace and conversation (never from stored or client input), sends only the calling
// member's ids, and the flow must read tenant-specific values (Composio user id, business
// context) from the variables/tweaks below rather than from hard-coded component settings.
// Uploaded files get random names, so one tenant's file can never be mistaken for another's.

export interface LangflowConfig {
  baseUrl: string;
  apiKey: string;
  flowId: string;
  /** Whether the flow's model streams tokens. */
  stream: boolean;
  /** Header name Langflow trusts for end-user identity, if enabled on the server. */
  endUserHeader?: string;
  /**
   * Tweaks template; "{{variable}}" placeholders are filled per run (see TEMPLATE_VARIABLES).
   * A value that is exactly "{{files}}" becomes the list of uploaded attachment paths, e.g.
   * { "ChatInput-abc": { "files": "{{files}}" } }; without one, attachments are unsupported.
   */
  tweaks?: unknown;
  fetch?: typeof fetch;
}

export const TEMPLATE_VARIABLES = [
  "workspace_id",
  "workspace_name",
  "user_id",
  "composio_user_id",
  "composio_toolkits",
  "business_context",
  "agent_instructions",
  "memories",
  "project_name",
  "project_instructions",
  "personal_guardrail",
  "system_context",
] as const;

/**
 * Langflow session id for a conversation: `<workspace>.<member's Composio id>.<conversation>`.
 * Namespaced by workspace so chat memory never mixes tenants. The member's Composio id is in
 * it because the session id is the only per-run value Langflow 1.12 restores when a paused
 * run resumes (tweaks are dropped), and the Member Apps node needs it then to rebuild that
 * member's tools.
 */
export function langflowSessionId(tenant: AgentTenantContext, conversationId: string): string {
  return `${tenant.workspaceId}.${tenant.composioUserId}.${conversationId}`;
}

// The profile and memories describe the business in general. Without this, a follow-up in a
// conversation about something new gets answered for what the business usually sells, and
// searches get narrowed to the business's city or niche though the owner never asked for that.
const BACKGROUND_ONLY =
  "Use the above as background only. The current conversation decides the topic: if the owner asks about something other than the business's usual products or work, stay on what they asked about, including in follow-ups that don't repeat it. Don't narrow a search or answer by the business's location, niche, or other details above unless the owner asked for that; if one would clearly change the answer, mention it as an option instead.";

export function templateValues(tenant: AgentTenantContext): Record<(typeof TEMPLATE_VARIABLES)[number], string> {
  const memories = tenant.memories.map((m) => `- ${m}`).join("\n");
  const project = tenant.project;
  const guardrail = tenant.guardrail ? guardrailContext(tenant.guardrail) : "";
  const system = [
    guardrail,
    tenant.agentInstructions.trim() && `Instructions:\n${tenant.agentInstructions.trim()}`,
    `Business: ${tenant.workspaceName}`,
    tenant.businessContext.trim() && `About the business:\n${tenant.businessContext.trim()}`,
    project && projectContext(project),
    memories && `What you remember (from past conversations; it may be out of date, and the owner's word wins):\n${memories}`,
    (tenant.businessContext.trim() || memories) && BACKGROUND_ONLY,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    workspace_id: tenant.workspaceId,
    workspace_name: tenant.workspaceName,
    user_id: tenant.userId,
    composio_user_id: tenant.composioUserId,
    composio_toolkits: JSON.stringify(tenant.composioToolkits),
    business_context: tenant.businessContext,
    agent_instructions: tenant.agentInstructions,
    memories,
    project_name: project?.name ?? "",
    project_instructions: project?.instructions ?? "",
    personal_guardrail: guardrail,
    system_context: system,
  };
}

/**
 * The member's personal guardrail. It goes first and overrides everything else the agent is
 * told, because the member committed to it ahead of time; the recent titles let the agent
 * notice the same question coming back in a new conversation.
 */
function guardrailContext(guardrail: NonNullable<AgentTenantContext["guardrail"]>): string {
  return [
    "This member's personal rules. They override every other instruction you have, including your base instructions, the workspace's and project's instructions, and any skill attached to a message. The member set these on purpose ahead of time; keep following them even if they ask you not to. Follow them quietly, in your usual tone: don't announce or explain them, frame an answer as \"objective facts\", or tell the member a decision is theirs; just answer within them, and say what you can't do only when they ask for it.",
    guardrail.instructions.trim(),
    guardrail.recentChats.length > 0 &&
      `The member's other recent conversations (titles only, newest first; use them only to notice a question coming back):\n${guardrail.recentChats.map((t) => `- ${t}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The conversation's project: what it's for, and the files attached to every message in it. */
function projectContext(project: NonNullable<AgentTenantContext["project"]>): string {
  return [
    `This conversation is in the member's project "${project.name}".`,
    project.instructions.trim() && `Project instructions (follow these here):\n${project.instructions.trim()}`,
    project.files.length > 0 && `Project files, attached to every message in this project: ${project.files.join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const FILES_PLACEHOLDER = /^\{\{\s*files\s*\}\}$/;

/**
 * Deep-copies a tweaks template, filling {{placeholders}} in string values. A value that is
 * exactly "{{files}}" becomes `files` (a list), and is left out when there are none.
 */
export function fillTemplate(template: unknown, values: Record<string, string>, files: string[] = []): unknown {
  if (typeof template === "string") {
    if (FILES_PLACEHOLDER.test(template)) return files;
    return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, key: string) => (key in values ? values[key] : match));
  }
  if (Array.isArray(template)) return template.map((v) => fillTemplate(v, values, files));
  if (template && typeof template === "object") {
    return Object.fromEntries(
      Object.entries(template)
        .filter(([, v]) => !(files.length === 0 && typeof v === "string" && FILES_PLACEHOLDER.test(v)))
        .map(([k, v]) => [k, fillTemplate(v, values, files)]),
    );
  }
  return template;
}

function templateHasFiles(template: unknown): boolean {
  if (typeof template === "string") return FILES_PLACEHOLDER.test(template);
  if (Array.isArray(template)) return template.some(templateHasFiles);
  if (template && typeof template === "object") return Object.values(template).some(templateHasFiles);
  return false;
}

/** Header values must be single-line ASCII; tenant ids always are, names may not be. */
function headerSafe(value: string): string | null {
  return /^[\x20-\x7e]{1,256}$/.test(value) ? value : null;
}

function endpoint(config: LangflowConfig, path: string): string {
  return new URL(path, config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`).toString();
}

/** Credentials, plus the calling member's ids when the request runs the flow for them. */
function headers(config: LangflowConfig, tenant?: AgentTenantContext): Record<string, string> {
  const out: Record<string, string> = { "x-api-key": config.apiKey };
  if (!tenant) return out;
  const values = templateValues(tenant);
  for (const [name, value] of [
    ["WORKSPACE_ID", values.workspace_id],
    ["USER_ID", values.user_id],
    ["COMPOSIO_USER_ID", values.composio_user_id],
  ] as const) {
    const safe = headerSafe(value);
    if (safe) out[`X-LANGFLOW-GLOBAL-VAR-${name}`] = safe;
  }
  if (config.endUserHeader) out[config.endUserHeader] = `${tenant.workspaceId}.${tenant.userId}`;
  return out;
}

/** The request that starts a run as a background job. `files` are uploaded attachment paths. */
export function buildRequest(config: LangflowConfig, input: AgentRunInput, files: string[] = []): { url: string; init: RequestInit } {
  const { tenant } = input;
  const body: Record<string, unknown> = {
    flow_id: config.flowId,
    input_value: input.message,
    session_id: langflowSessionId(tenant, input.conversationId),
    mode: "background",
    stream_protocol: "langflow",
  };
  if (config.tweaks) body.tweaks = fillTemplate(config.tweaks, templateValues(tenant), files);
  return {
    url: endpoint(config, "api/v2/workflows"),
    init: {
      method: "POST",
      headers: { ...headers(config, tenant), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: input.signal,
    },
  };
}

// ------------------------------------------------------------------------------------------
// Response translation

interface LangflowToolUse {
  type: "tool_use";
  name?: string | null;
  tool_input?: unknown;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  header?: { title?: string | null } | null;
}

interface LangflowMessage {
  id?: string;
  sender?: string;
  sender_name?: string;
  text?: unknown;
  session_id?: string;
  content_blocks?: { type?: string; title?: string; contents?: unknown[] }[] | null;
}

/**
 * The text and tool-call entries of a bot message, in order. Langflow sends two shapes: a
 * "Agent Steps" block holding them in `contents` (v1 streams, and a background job's final
 * message), and, while a background job runs, the entries themselves as the blocks.
 */
function leaves(message: LangflowMessage): { type?: string; text?: unknown }[] {
  const out: { type?: string; text?: unknown }[] = [];
  for (const block of message.content_blocks ?? []) {
    if (!block || typeof block !== "object") continue;
    if (block.contents?.length) {
      for (const c of block.contents) if (c && typeof c === "object") out.push(c as never);
    } else if (block.type === "tool_use" || block.type === "text") {
      out.push(block as never);
    }
  }
  return out;
}

function toolUses(message: LangflowMessage): LangflowToolUse[] {
  return leaves(message).filter((l): l is LangflowToolUse => l.type === "tool_use");
}

function short(value: unknown, max = 160): string | undefined {
  if (value == null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toCalls(message: LangflowMessage): ToolCall[] {
  return toolUses(message).map((tool) => ({
    name: tool.name ?? "tool",
    input: tool.tool_input ?? tool.input ?? {},
    output: tool.output,
    error: tool.error,
  }));
}

/**
 * Steps for the tool calls in a bot message, in plain language with the app each worked in
 * (see src/lib/agent/tools). Ids are keyed by message and call position, so re-sent
 * messages update the same steps.
 */
export function toolActivity(message: LangflowMessage, messageKey: string): AgentEvent[] {
  return interpretCalls(toCalls(message)).map(
    (step) =>
      ({
        type: "activity",
        id: `${messageKey}:${step.index}`,
        label: step.label,
        status: step.status,
        detail: step.detail,
        app: step.app,
        action: step.action,
        preview: step.preview,
        hidden: step.hidden,
      }) satisfies AgentEvent,
  );
}

/**
 * Artifacts come only from structured tool results: a file-creating tool's own result
 * (e.g. a new spreadsheet's URL), or tool output that explicitly declares
 * `{ "artifact": { "id", "kind", "title", "url", ... } }`. Text is never parsed for links.
 */
export function toolArtifacts(message: LangflowMessage): AgentEvent[] {
  const events: AgentEvent[] = [];
  const seen = new Set<string>();
  const push = (artifact: { id?: unknown; url?: unknown }) => {
    const key = String(artifact.url ?? artifact.id ?? "");
    if (seen.has(key)) return;
    seen.add(key);
    events.push({ type: "artifact", artifact: artifact as never });
  };
  for (const step of interpretCalls(toCalls(message))) {
    for (const artifact of step.artifacts ?? []) push(artifact);
  }
  for (const tool of toolUses(message)) {
    let output = tool.output;
    if (typeof output === "string" && output.trimStart().startsWith("{")) {
      try {
        output = JSON.parse(output);
      } catch {
        continue;
      }
    }
    const artifact = output && typeof output === "object" ? (output as { artifact?: unknown }).artifact : undefined;
    if (artifact && typeof artifact === "object") push(artifact as { id?: unknown; url?: unknown });
  }
  return events;
}

/**
 * Memory suggestions come only from tool output that declares
 * `{ "memory_proposal": { "content", "scope" } }` (the Studio gateway's remember tool).
 */
export function toolMemoryProposals(message: LangflowMessage): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const tool of toolUses(message)) {
    if (tool.output == null || tool.error) continue;
    const result = unwrapResult(tool.output);
    const proposal = isRecord(result) && isRecord(result.memory_proposal) ? result.memory_proposal : undefined;
    const content = typeof proposal?.content === "string" ? proposal.content.replace(/\s+/g, " ").trim() : "";
    if (!content || events.some((e) => e.type === "memory-proposal" && e.content === content)) continue;
    events.push({
      type: "memory-proposal",
      content,
      scope: proposal?.scope === "personal" ? "personal" : "workspace",
      category: toMemoryCategory(proposal?.category),
    });
  }
  return events;
}

/** Timelines a "why?" investigation reported through report_timeline (validated by the turn). */
export function toolTimelines(message: LangflowMessage): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const tool of toolUses(message)) {
    if (tool.output == null || tool.error) continue;
    const result = unwrapResult(tool.output);
    if (isRecord(result) && isRecord(result.timeline)) events.push({ type: "timeline", timeline: result.timeline });
  }
  return events;
}

/** Multiple-choice questions the agent asked through ask_user (validated by the turn). */
export function toolQuestions(message: LangflowMessage): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const tool of toolUses(message)) {
    if (tool.output == null || tool.error) continue;
    const result = unwrapResult(tool.output);
    if (isRecord(result) && isRecord(result.ask_user)) events.push({ type: "questions", questions: result.ask_user.questions });
  }
  return events;
}

/** The step of the tool call a run paused on, so the resumed call settles it. */
interface PausedStep {
  /** The step's id (`<message key>:<call index>`). */
  id: string;
  /** The key of the bot message that held the call. */
  messageKey: string;
  /** The tool the call ran: a gateway call's target (see callTarget). */
  tool: string;
}

/** What the paused run needs to continue. Stored by the app, never shown to the browser. */
interface PausedJob {
  jobId: string;
  requestId: string;
  lastEventId: string | null;
  step?: PausedStep;
}

function pausedJob(state: unknown): PausedJob | null {
  if (!isRecord(state) || typeof state.jobId !== "string" || typeof state.requestId !== "string") return null;
  const step = isRecord(state.step) ? state.step : undefined;
  return {
    jobId: state.jobId,
    requestId: state.requestId,
    lastEventId: typeof state.lastEventId === "string" ? state.lastEventId : null,
    step:
      typeof step?.id === "string" && typeof step.messageKey === "string" && typeof step.tool === "string"
        ? { id: step.id, messageKey: step.messageKey, tool: step.tool }
        : undefined,
  };
}

/**
 * The tool a call ran. Gateway calls name their target in `tool_name`, and Langflow may report
 * the same paused call under different gateway names (execute_tool while it streams,
 * take_action once resumed), so calls are matched by target.
 */
function callTarget(name: unknown, input: unknown): string {
  return isRecord(input) && typeof input.tool_name === "string" ? input.tool_name : typeof name === "string" ? name : "tool";
}

/**
 * The step of the call a run paused on: the latest call in the last bot message, to the tool
 * the approval request names, that hasn't run yet. Langflow doesn't always report the call
 * before pausing; then there is no step to settle.
 */
function pausedStep(message: LangflowMessage | undefined, request: Record<string, unknown>): PausedStep | undefined {
  const action = Array.isArray(request.action_requests) && isRecord(request.action_requests[0]) ? request.action_requests[0] : {};
  if (!message || typeof action.name !== "string") return undefined;
  const tool = callTarget(action.name, action.args);
  const index = toolUses(message).findLastIndex((t) => callTarget(t.name, t.tool_input ?? t.input) === tool && t.output == null && !t.error);
  if (index < 0) return undefined;
  const messageKey = message.id ?? "message";
  return { id: `${messageKey}:${index}`, messageKey, tool };
}

const APPROVAL_FIELD_MAX = 6;

/**
 * The approval card for a paused tool call: the agent's own summary, the app it acts in, and
 * a few readable arguments. Built from the take_action call the run paused on.
 */
export function approvalFor(data: unknown): { summary: string; app?: string; details: [string, string][] } {
  const request = isRecord(data) && Array.isArray(data.action_requests) && isRecord(data.action_requests[0]) ? data.action_requests[0] : {};
  const args = isRecord(request.args) ? request.args : {};
  let tool = typeof args.tool_name === "string" ? args.tool_name : typeof request.name === "string" ? request.name : "";
  let fields: unknown = args.arguments;
  if (typeof fields === "string") fields = maybeJson(fields);
  // Composio actions arrive wrapped in the multi-execute tool; show the inner action.
  if (tool === "composio_multi_execute_tool" && isRecord(fields) && Array.isArray(fields.tools) && isRecord(fields.tools[0])) {
    const inner = fields.tools[0];
    tool = typeof inner.tool_slug === "string" ? inner.tool_slug : tool;
    fields = inner.arguments;
  }
  const app = /^[A-Z][A-Z0-9]*_/.test(tool) ? appForToolkit(tool) : tool === "act" ? "browser" : undefined;
  const details: [string, string][] = [];
  if (isRecord(fields)) {
    for (const [key, value] of Object.entries(fields)) {
      if (details.length >= APPROVAL_FIELD_MAX) break;
      if (value == null || value === "" || /^(current_step|thought)$/.test(key)) continue;
      const text = typeof value === "string" ? value : JSON.stringify(value);
      details.push([clip(humanizeKey(key), 40), clip(text, 300)]);
    }
  }
  const fallback = typeof data === "object" && isRecord(data) && typeof data.prompt === "string" ? data.prompt.split("\n")[0] : "";
  const summary = clip(typeof args.summary === "string" && args.summary.trim() ? args.summary : fallback || "The agent wants to make a change", 500);
  return { summary, app, details };
}

function humanizeKey(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Model-provider failures in plain words; anything else keeps a short excerpt. */
export function friendlyError(detail: string): string {
  if (/\b402\b|credit|in_flight_budget|insufficient_quota|billing/i.test(detail)) {
    return "The AI model account is out of credit or at its limit. Add credits with your model provider (e.g. OpenRouter), then retry.";
  }
  if (/\b429\b|rate.?limit|too many requests/i.test(detail)) return "The AI model is busy or rate-limited. Try again in a minute.";
  if (/\b(401|403)\b|invalid api key|unauthorized/i.test(detail)) return "The AI model rejected the agent's credentials. Check the model API key in Langflow.";
  if (/context length|maximum context|too many tokens/i.test(detail)) return "The conversation got too long for the model. Start a new chat and try again.";
  return `The agent ran into a problem: ${short(detail, 300)}`;
}

/** Longest text treated as a possible opening line before it is released as the answer. */
const NOTE_MAX = 280;

/** Text blocks that come before a tool call in a bot message: the agent's opening lines. */
export function leadingNotes(message: LangflowMessage): string[] {
  const all = leaves(message);
  const lastTool = all.map((l) => l.type).lastIndexOf("tool_use");
  return all
    .slice(0, Math.max(0, lastTool))
    .filter((l) => l.type === "text" && typeof l.text === "string" && l.text.trim())
    .map((l) => (l.text as string).trim());
}

/** Langflow prefixes the final text with any opening lines; strip them from the answer. */
export function withoutNotes(text: string, notes: string[]): string {
  let rest = text;
  for (const note of notes) {
    const trimmed = rest.trimStart();
    if (trimmed.startsWith(note)) rest = trimmed.slice(note.length);
  }
  return rest.trimStart();
}

function isBot(message: LangflowMessage): boolean {
  return message.sender === "Machine";
}

function resultMessage(result: unknown): LangflowMessage | undefined {
  const outputs = (result as { outputs?: { outputs?: { results?: { message?: LangflowMessage } }[] }[] })?.outputs;
  return outputs?.[0]?.outputs?.[0]?.results?.message;
}

function errorFor(status: number): AgentError {
  if (status === 401 || status === 403) return new AgentError("The agent service rejected this app's credentials.", { retryable: false });
  if (status === 404) return new AgentError("The agent flow wasn't found. Check the Langflow flow id.", { retryable: false });
  if (status === 422) return new AgentError("The agent flow rejected the request. Check its configuration.", { retryable: false });
  if (status === 429) return new AgentError("The agent service is busy. Try again in a moment.");
  return new AgentError("The agent service had a problem. Try again in a moment.");
}

/**
 * Splits a server-sent event stream into parsed events. Frames are separated by a blank
 * line; "data:" lines carry the JSON and an "id:" line its position for Last-Event-ID.
 * Unprefixed lines are read as data too.
 */
export async function* parseEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: unknown; id?: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (chunk: string) => {
    let id: string | undefined;
    const data: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (/^(event|retry):/.test(line) || line.startsWith(":")) continue;
      else data.push(line.replace(/^data:\s?/, ""));
    }
    const json = data.join("\n").trim();
    if (!json) return null;
    try {
      const parsed = JSON.parse(json) as { event: string; data: unknown };
      return id === undefined ? parsed : { ...parsed, id };
    } catch {
      return null;
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let split: number;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const event = parse(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    const last = parse(buffer);
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

const EXPIRED = "This request expired before it was answered, so nothing was done. Ask again to retry.";

const RESTARTED = "The agent service restarted partway through, so this reply was lost. Try again.";

/** Times the event stream may drop and be re-read from the last event before giving up. */
const RECONNECTS = 2;

export function createLangflowAdapter(config: LangflowConfig): AgentAdapter {
  const doFetch = config.fetch ?? fetch;
  const acceptsFiles = templateHasFiles(config.tweaks);

  async function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return doFetch(endpoint(config, path), {
      method: "POST",
      headers: { ...headers(config), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  async function stopJob(jobId: string): Promise<void> {
    await post("api/v2/workflows/stop", { job_id: jobId }).catch(() => undefined);
  }

  /** Uploads attachments under random names and returns their Langflow paths. */
  async function upload(input: AgentRunInput): Promise<string[]> {
    const paths: string[] = [];
    for (const file of input.attachments) {
      const form = new FormData();
      const name = `${crypto.randomUUID()}-${file.name.replace(/[^\w.-]+/g, "_").slice(-120)}`;
      form.append("file", new Blob([await file.read()], { type: file.mimeType }), name);
      let response: Response;
      try {
        response = await doFetch(endpoint(config, "api/v2/files"), { method: "POST", headers: headers(config), body: form, signal: input.signal });
      } catch (error) {
        if (input.signal.aborted) throw error;
        throw new AgentError("Couldn't send your files to the agent.", { cause: error });
      }
      const result = (await response.json().catch(() => null)) as { path?: unknown } | null;
      if (!response.ok || typeof result?.path !== "string") throw new AgentError(`The agent couldn't take “${file.name}”. Try a different file.`);
      paths.push(result.path);
    }
    return paths;
  }

  return {
    id: "langflow",
    label: "Agent connected",
    live: true,
    capabilities: {
      streaming: config.stream,
      cancellation: "abort",
      toolEvents: true,
      artifacts: true,
      runStatus: false,
      approvals: true,
      attachments: acceptsFiles,
      // With an end-user header Langflow stores memory under a scoped session id; rewinding
      // that hasn't been verified, so it isn't claimed.
      rewind: !config.endUserHeader,
    },

    async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
      const sessionId = langflowSessionId(input.tenant, input.conversationId);
      yield { type: "thread", threadId: sessionId };

      let jobId: string;
      let lastEventId: string | null = null;
      /** The step the run paused on, still running until the resumed call settles it. */
      let carried: PausedStep | undefined;
      if (input.resume) {
        const paused = pausedJob(input.resume.state);
        if (!paused) throw new AgentError(EXPIRED, { retryable: false, code: "expired" });
        const decision =
          input.resume.decision === "approve"
            ? { action_id: "approve" }
            : { action_id: "reject", values: { message: input.resume.note || "The owner declined this action. Don't retry it." } };
        let response: Response;
        try {
          response = await post(`api/v2/workflows/${encodeURIComponent(paused.jobId)}/resume`, { request_id: paused.requestId, decision }, input.signal);
        } catch (error) {
          if (input.signal.aborted) throw error;
          throw new AgentError("Couldn't reach the agent service.", { cause: error });
        }
        if (response.status === 404 || response.status === 409 || response.status === 422) {
          throw new AgentError(EXPIRED, { retryable: false, code: "expired" });
        }
        if (!response.ok) throw errorFor(response.status);
        jobId = paused.jobId;
        lastEventId = paused.lastEventId;
        carried = paused.step;
      } else {
        if (input.attachments.length > 0 && !acceptsFiles) {
          throw new AgentError("This agent can't read attached files yet.", { retryable: false });
        }
        const files = await upload(input);
        const { url, init } = buildRequest(config, input, files);
        let response: Response;
        try {
          response = await doFetch(url, init);
        } catch (error) {
          if (input.signal.aborted) throw error;
          throw new AgentError("Couldn't reach the agent service.", { cause: error });
        }
        if (!response.ok) throw errorFor(response.status);
        const job = (await response.json().catch(() => null)) as { job_id?: unknown } | null;
        if (typeof job?.job_id !== "string") throw new AgentError("The agent service returned an unreadable response.");
        jobId = job.job_id;
      }

      // Stop means stop: cancel the job on the Langflow side, not just stop reading it.
      const onAbort = () => void stopJob(jobId);
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
      try {
        // Short text the agent writes right before calling a tool is an opening line ("Let me
        // look through your emails"), not part of the answer. Langflow streams it as tokens
        // and then concatenates it onto the final text, so short text is held back until we
        // know: a tool call next means it was a note; otherwise it is released as the answer.
        let tokens = false;
        let shownText = "";
        let pending = "";
        let releasing = false;
        let toolCount = 0;
        const notes: string[] = [];
        let lastBot: LangflowMessage | undefined;
        const seenArtifacts = new Set<string>();
        const seenProposals = new Set<string>();
        const seenReports = new Set<string>();
        const newReports = (message: LangflowMessage) =>
          [...toolTimelines(message), ...toolQuestions(message)].filter((t) => {
            const key = JSON.stringify(t);
            if (seenReports.has(key)) return false;
            seenReports.add(key);
            return true;
          });
        // A resumed run reports the approved (or declined) call again, in a new bot message.
        // That call keeps the paused step's id, so it settles the step instead of adding one.
        let carriedFrom: string | undefined;
        const activityFor = (message: LangflowMessage, messageKey: string): AgentEvent[] => {
          const events = toolActivity(message, messageKey);
          if (!carried || messageKey === carried.messageKey) return events;
          if (carriedFrom === undefined) {
            const index = toolUses(message).findIndex((t) => callTarget(t.name, t.tool_input ?? t.input) === carried!.tool);
            if (index < 0) return events;
            carriedFrom = `${messageKey}:${index}`;
          }
          return events.map((e) => (e.type === "activity" && e.id === carriedFrom ? { ...e, id: carried!.id } : e));
        };

        for (let attempt = 0; attempt <= RECONNECTS; attempt++) {
          let response: Response;
          try {
            response = await doFetch(endpoint(config, `api/v2/workflows/${encodeURIComponent(jobId)}/events`), {
              headers: { ...headers(config), Accept: "text/event-stream", ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}) },
              signal: input.signal,
            });
          } catch (error) {
            if (input.signal.aborted) throw error;
            if (attempt < RECONNECTS) continue;
            throw new AgentError("Lost the connection to the agent service.", { cause: error });
          }
          // Jobs live in the Langflow process: after a restart, reading on finds no such job.
          if (attempt > 0 && response.status === 404) throw new AgentError(RESTARTED);
          if (!response.ok || !response.body) throw errorFor(response.status);

          for await (const { event, data, id } of parseEventStream(response.body)) {
            if (id) lastEventId = id;
            if (event === "token") {
              const chunk = (data as { chunk?: unknown })?.chunk;
              if (typeof chunk === "string" && chunk) {
                tokens = true;
                if (releasing) {
                  shownText += chunk;
                  yield { type: "text-delta", text: chunk };
                } else {
                  pending += chunk;
                  if (pending.length > NOTE_MAX || pending.includes("\n\n")) {
                    releasing = true;
                    shownText += pending;
                    yield { type: "text-delta", text: pending };
                    pending = "";
                  }
                }
              }
            } else if (event === "add_message") {
              const message = data as LangflowMessage;
              if (!isBot(message)) continue;
              lastBot = message;
              const calls = toolUses(message).length;
              if (calls > toolCount) {
                toolCount = calls;
                if (pending.trim()) {
                  notes.push(pending.trim());
                  yield { type: "note", text: pending.trim() };
                }
                pending = "";
                releasing = false;
              }
              if (!tokens) {
                for (const note of leadingNotes(message)) {
                  if (!notes.includes(note)) {
                    notes.push(note);
                    yield { type: "note", text: note };
                  }
                }
              }
              yield* activityFor(message, message.id ?? "message");
              for (const a of toolArtifacts(message)) {
                const key = JSON.stringify(a);
                if (!seenArtifacts.has(key)) {
                  seenArtifacts.add(key);
                  yield a;
                }
              }
              yield* newReports(message);
              for (const p of toolMemoryProposals(message)) {
                if (p.type === "memory-proposal" && !seenProposals.has(p.content)) {
                  seenProposals.add(p.content);
                  yield p;
                }
              }
              const answer = typeof message.text === "string" ? withoutNotes(message.text, notes) : "";
              if (!tokens && answer && answer !== shownText) {
                shownText = answer;
                yield { type: "message", text: answer };
              }
            } else if (event === "human_input_required") {
              const request = isRecord(data) ? data : {};
              if (request.kind !== "tool_approval" || typeof request.request_id !== "string") {
                void stopJob(jobId);
                throw new AgentError("The agent asked for a kind of input this app can't show yet.", { retryable: false });
              }
              if (pending.trim()) {
                notes.push(pending.trim());
                yield { type: "note", text: pending.trim() };
                pending = "";
              }
              // A run paused again before reporting the carried call keeps pointing at it.
              let step = pausedStep(lastBot, request) ?? (carriedFrom === undefined ? carried : undefined);
              if (step && step.id === carriedFrom) step = carried;
              const state: PausedJob = { jobId, requestId: request.request_id, lastEventId, step };
              yield { type: "approval", ...approvalFor(request), state };
              return;
            } else if (event === "error") {
              const detail = (data as { error?: unknown })?.error;
              throw new AgentError(typeof detail === "string" && detail ? friendlyError(detail) : "The agent ran into a problem.");
            } else if (event === "end") {
              if (pending) {
                shownText += pending;
                yield { type: "text-delta", text: pending };
                pending = "";
              }
              const final = resultMessage((data as { result?: unknown })?.result) ?? lastBot;
              const text = typeof final?.text === "string" ? withoutNotes(final.text, notes) : "";
              if (text && text !== shownText && !tokens) yield { type: "message", text };
              if (final) {
                yield* activityFor(final, lastBot?.id ?? final.id ?? "message");
                // A suggestion made right before the end may only arrive in the result message.
                yield* newReports(final);
                for (const p of toolMemoryProposals(final)) {
                  if (p.type === "memory-proposal" && !seenProposals.has(p.content)) {
                    seenProposals.add(p.content);
                    yield p;
                  }
                }
              }
              return;
            }
          }
          if (input.signal.aborted) return;
          // The stream closed without an end: read on from the last event.
        }
        if (pending) {
          shownText += pending;
          yield { type: "text-delta", text: pending };
        }
        if (!shownText) throw new AgentError("The agent stopped before finishing.");
      } finally {
        input.signal.removeEventListener("abort", onAbort);
      }
    },

    async rewind({ tenant, conversationId }, turns) {
      if (turns < 1) return;
      const url = new URL(endpoint(config, "api/v1/monitor/messages"));
      url.searchParams.set("flow_id", config.flowId);
      url.searchParams.set("session_id", langflowSessionId(tenant, conversationId));
      url.searchParams.set("order", "ASC");
      url.searchParams.set("limit", "1000");
      const response = await doFetch(url.toString(), { headers: headers(config) });
      if (!response.ok) throw errorFor(response.status);
      const messages = ((await response.json().catch(() => [])) as { id?: unknown; sender?: unknown }[]).filter(
        (m): m is { id: string; sender?: unknown } => typeof m?.id === "string",
      );
      const users = messages.flatMap((m, i) => (m.sender === "User" ? [i] : []));
      if (users.length === 0) return;
      const from = users[Math.max(0, users.length - turns)];
      const ids = messages.slice(from).map((m) => m.id);
      const removed = await doFetch(endpoint(config, "api/v1/monitor/messages"), {
        method: "DELETE",
        headers: { ...headers(config), "Content-Type": "application/json" },
        body: JSON.stringify(ids),
      });
      if (!removed.ok) throw errorFor(removed.status);
    },

    async discard(state) {
      const paused = pausedJob(state);
      if (paused) await stopJob(paused.jobId);
    },
  };
}

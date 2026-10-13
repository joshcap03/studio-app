import { interpretCalls, type ToolCall } from "./tools";
import { AgentError, type AgentAdapter, type AgentEvent, type AgentRunInput, type AgentTenantContext } from "./types";

// Langflow adapter. Everything Langflow-specific lives in this file.
//
// Contract (verified against Langflow 1.12.5, its source and a live server):
//   POST {base}/api/v1/run/{flow_id}[?stream=true]   header x-api-key
//   body { input_value, input_type: "chat", output_type: "chat", session_id, tweaks? }
//   non-streaming → { session_id, outputs: [{ outputs: [{ results: { message: { text, content_blocks }}}]}]}
//   streaming     → text/event-stream body of JSON objects separated by blank lines:
//                   { event: "add_message" | "token" | "end" | "error" | …, data }
//                   token.data.chunk is incremental text (only when the flow's model streams);
//                   add_message.data is a Message (sender "Machine" for the bot) whose
//                   content_blocks hold tool calls as { type: "tool_use", name, tool_input,
//                   output, error, duration }; end.data.result is the full run result;
//                   error.data.error is a message.
//   Cancellation: closing the connection cancels the run server-side (best effort).
//   Per-request global variables: X-LANGFLOW-GLOBAL-VAR-{NAME} headers.
//   Optional trusted end-user header (LANGFLOW_SERVING_END_USER_HEADER on the Langflow
//   server) scopes Langflow's own chat memory to "<end_user>::<session_id>".
//
// Tenant isolation does not rely on the flow: this adapter derives the session id from the
// workspace and conversation (never from stored or client input), sends only the calling
// member's ids, and the flow must read tenant-specific values (Composio user id, business
// context) from the variables/tweaks below rather than from hard-coded component settings.

export interface LangflowConfig {
  baseUrl: string;
  apiKey: string;
  flowId: string;
  stream: boolean;
  /** Header name Langflow trusts for end-user identity, if enabled on the server. */
  endUserHeader?: string;
  /** Tweaks template; "{{variable}}" placeholders are filled per run (see TEMPLATE_VARIABLES). */
  tweaks?: unknown;
  fetch?: typeof fetch;
}

export const TEMPLATE_VARIABLES = [
  "workspace_id",
  "workspace_name",
  "user_id",
  "composio_user_id",
  "business_context",
  "agent_instructions",
  "memories",
  "system_context",
] as const;

/** Langflow session id for a conversation: always namespaced by workspace. */
export function langflowSessionId(tenant: AgentTenantContext, conversationId: string): string {
  return `${tenant.workspaceId}.${conversationId}`;
}

export function templateValues(tenant: AgentTenantContext): Record<(typeof TEMPLATE_VARIABLES)[number], string> {
  const memories = tenant.memories.map((m) => `- ${m}`).join("\n");
  const system = [
    tenant.agentInstructions.trim() && `Instructions:\n${tenant.agentInstructions.trim()}`,
    `Business: ${tenant.workspaceName}`,
    tenant.businessContext.trim() && `About the business:\n${tenant.businessContext.trim()}`,
    memories && `Things to remember:\n${memories}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    workspace_id: tenant.workspaceId,
    workspace_name: tenant.workspaceName,
    user_id: tenant.userId,
    composio_user_id: tenant.composioUserId,
    business_context: tenant.businessContext,
    agent_instructions: tenant.agentInstructions,
    memories,
    system_context: system,
  };
}

/** Deep-copies a tweaks template, filling {{placeholders}} in string values. */
export function fillTemplate(template: unknown, values: Record<string, string>): unknown {
  if (typeof template === "string") {
    return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, key: string) => (key in values ? values[key] : match));
  }
  if (Array.isArray(template)) return template.map((v) => fillTemplate(v, values));
  if (template && typeof template === "object") {
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, fillTemplate(v, values)]));
  }
  return template;
}

/** Header values must be single-line ASCII; tenant ids always are, names may not be. */
function headerSafe(value: string): string | null {
  return /^[\x20-\x7e]{1,256}$/.test(value) ? value : null;
}

export function buildRequest(config: LangflowConfig, input: AgentRunInput): { url: string; init: RequestInit } {
  const { tenant } = input;
  const values = templateValues(tenant);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: config.stream ? "text/event-stream" : "application/json",
    "x-api-key": config.apiKey,
  };
  for (const [name, value] of [
    ["WORKSPACE_ID", values.workspace_id],
    ["USER_ID", values.user_id],
    ["COMPOSIO_USER_ID", values.composio_user_id],
  ] as const) {
    const safe = headerSafe(value);
    if (safe) headers[`X-LANGFLOW-GLOBAL-VAR-${name}`] = safe;
  }
  if (config.endUserHeader) headers[config.endUserHeader] = `${tenant.workspaceId}.${tenant.userId}`;

  const body: Record<string, unknown> = {
    input_value: input.message,
    input_type: "chat",
    output_type: "chat",
    session_id: langflowSessionId(tenant, input.conversationId),
  };
  if (config.tweaks) body.tweaks = fillTemplate(config.tweaks, values);

  const url = new URL(`api/v1/run/${encodeURIComponent(config.flowId)}`, config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`);
  if (config.stream) url.searchParams.set("stream", "true");
  return { url: url.toString(), init: { method: "POST", headers, body: JSON.stringify(body), signal: input.signal } };
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
  content_blocks?: { title?: string; contents?: unknown[] }[] | null;
}

function toolUses(message: LangflowMessage): LangflowToolUse[] {
  const out: LangflowToolUse[] = [];
  for (const block of message.content_blocks ?? []) {
    for (const content of block?.contents ?? []) {
      if (content && typeof content === "object" && (content as { type?: string }).type === "tool_use") {
        out.push(content as LangflowToolUse);
      }
    }
  }
  return out;
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
  const leaves: { type?: string; text?: unknown }[] = [];
  for (const block of message.content_blocks ?? []) for (const c of block?.contents ?? []) if (c && typeof c === "object") leaves.push(c as never);
  const lastTool = leaves.map((l) => l.type).lastIndexOf("tool_use");
  return leaves
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

/** Splits a Langflow event stream into parsed events (blank-line framed JSON). */
export async function* parseEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (chunk: string) => {
    const json = chunk
      .split("\n")
      .map((line) => line.replace(/^data:\s?/, ""))
      .join("\n")
      .trim();
    if (!json) return null;
    try {
      return JSON.parse(json) as { event: string; data: unknown };
    } catch {
      return null;
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
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

export function createLangflowAdapter(config: LangflowConfig): AgentAdapter {
  const doFetch = config.fetch ?? fetch;
  return {
    id: "langflow",
    label: "Agent connected",
    live: true,
    capabilities: {
      streaming: config.stream,
      cancellation: "disconnect",
      toolEvents: true,
      artifacts: true,
      runStatus: false,
    },

    async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
      const { url, init } = buildRequest(config, input);
      const sessionId = langflowSessionId(input.tenant, input.conversationId);
      yield { type: "thread", threadId: sessionId };

      let response: Response;
      try {
        response = await doFetch(url, init);
      } catch (error) {
        if (input.signal.aborted) throw error;
        throw new AgentError("Couldn't reach the agent service.", { cause: error });
      }
      if (!response.ok) throw errorFor(response.status);

      if (!config.stream || !response.body || !response.headers.get("content-type")?.includes("event-stream")) {
        const result = (await response.json().catch(() => null)) as { session_id?: string } | null;
        if (!result) throw new AgentError("The agent service returned an unreadable response.");
        const message = resultMessage(result);
        const notes = message ? leadingNotes(message) : [];
        for (const note of notes) yield { type: "note", text: note };
        if (message) {
          yield* toolActivity(message, message.id ?? "result");
          yield* toolArtifacts(message);
        }
        const text = typeof message?.text === "string" ? withoutNotes(message.text, notes) : "";
        if (text) yield { type: "message", text };
        return;
      }

      // Short text the agent writes right before calling a tool is an opening line ("Let me
      // look through your emails"), not part of the answer. Langflow streams it as tokens and
      // then concatenates it onto the final text, so short text is held back until we know:
      // a tool call next means it was a note; otherwise it is released as the answer.
      let tokens = false;
      let shownText = "";
      let pending = "";
      let releasing = false;
      let toolCount = 0;
      const notes: string[] = [];
      let lastBot: LangflowMessage | undefined;
      const seenArtifacts = new Set<string>();

      for await (const { event, data } of parseEventStream(response.body)) {
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
          yield* toolActivity(message, message.id ?? "message");
          for (const a of toolArtifacts(message)) {
            const key = JSON.stringify(a);
            if (!seenArtifacts.has(key)) {
              seenArtifacts.add(key);
              yield a;
            }
          }
          const answer = typeof message.text === "string" ? withoutNotes(message.text, notes) : "";
          if (!tokens && answer && answer !== shownText) {
            shownText = answer;
            yield { type: "message", text: answer };
          }
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
          if (final) yield* toolActivity(final, lastBot?.id ?? final.id ?? "message");
          return;
        }
      }
      if (pending && !input.signal.aborted) {
        shownText += pending;
        yield { type: "text-delta", text: pending };
      }
      // The stream closed without an end event.
      if (!input.signal.aborted && !shownText) throw new AgentError("The agent stopped before finishing.");
    },
  };
}

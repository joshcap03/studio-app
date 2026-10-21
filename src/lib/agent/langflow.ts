import { appForToolkit } from "@/lib/apps";
import { seamBetween } from "@/lib/chat/seam";
import { toMemoryCategory } from "@/lib/types";
import { evidenceFor, interpretCalls, keepsBooks, OPENING_LINE_MAX, opensWork, reportsOnAnswer, type ToolCall } from "./tools";
import { clip, isRecord, maybeJson, unwrapResult } from "./tools/sanitize";
import { AgentError, type AgentAdapter, type AgentEvent, type AgentRunInput, type AgentTenantContext, type ApprovalAction } from "./types";

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
//   Tracing: a background job's graph runs under its job_id (resumes included), and Langflow's
//   LangSmith tracer opens the root run with that id, so the job id is the trace id.
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
  "agent_profile",
  // Older name for agent_profile, kept so existing LANGFLOW_TWEAKS templates keep working.
  "business_context",
  "agent_instructions",
  "memories",
  "project_name",
  "project_instructions",
  "personal_guardrail",
  "system_context",
  // The person's saved sign-ins for the agent's browser, for Studio Browser's context_id.
  "browser_context",
] as const;

/**
 * Langflow session id for a conversation: `<workspace>.<member's Composio id>.<conversation>`.
 * Namespaced by workspace so chat memory never mixes tenants. The member's Composio id is in
 * it because the session id is the only per-run value Langflow 1.12 restores when a paused
 * run resumes (tweaks are dropped), and the Member Apps node needs it then to rebuild that
 * member's tools.
 */
export function langflowSessionId(tenant: Pick<AgentTenantContext, "workspaceId" | "composioUserId">, conversationId: string): string {
  return `${tenant.workspaceId}.${tenant.composioUserId}.${conversationId}`;
}

// The profile and memories describe this agent's usual work. Without this, a follow-up in a
// conversation about something new gets answered for this agent's usual work, and searches
// get narrowed to its city or niche though the owner never asked for that.
const BACKGROUND_ONLY =
  "Use the above as background only. The current conversation decides the topic: if the owner asks about something other than this agent's usual work, stay on what they asked about, including in follow-ups that don't repeat it. Don't narrow a search or answer by the location, niche, or other details above unless the owner asked for that; if one would clearly change the answer, mention it as an option instead.";

const TRACKER_CHARS = 5000;

/**
 * Said only where the member could take a call (the app drops offers everywhere else). It names
 * no tool: a flow from before offer_call has none, and the instructions that come with the tool
 * say when to use it.
 */
/** The facts the agent saved most recently, by id, so a change updates one instead of adding another. */
function recentMemoriesContext(facts: { id: string; content: string }[]): string {
  return [
    "Facts you saved most recently, newest first. When something you'd remember changes, corrects, or restates one of these, call remember with the whole current version and its id in replaces (several ids when it sums up several), so there's one fact, not another copy. If one already says it, don't remember it again.",
    ...facts.map((f) => `- [${f.id}] ${f.content}`),
  ].join("\n");
}

const CALLS_CONTEXT = "The member can also talk this through with you on a call; it's theirs to start.";

export function templateValues(tenant: AgentTenantContext): Record<(typeof TEMPLATE_VARIABLES)[number], string> {
  const memories = tenant.memories.map((m) => `- ${m}`).join("\n");
  const project = tenant.project;
  const guardrail = tenant.guardrail ? guardrailContext(tenant.guardrail) : "";
  const system = [
    guardrail,
    tenant.modality && modalityContext(tenant.modality),
    tenant.calls && CALLS_CONTEXT,
    tenant.agentInstructions.trim() && `Instructions:\n${tenant.agentInstructions.trim()}`,
    tenant.account?.name.trim() && `You're assisting: ${tenant.account.name.trim()}`,
    tenant.account?.about.trim() && `About them:\n${tenant.account.about.trim()}`,
    `This agent: ${tenant.workspaceName}`,
    tenant.self && selfContext(tenant.self),
    tenant.profile.trim() && `What this agent is for:\n${tenant.profile.trim()}`,
    tenant.agentFiles?.length && `Your files (the member's, attached to every message with this agent): ${tenant.agentFiles.join(", ")}`,
    project && projectContext(project),
    tenant.task && taskContext(tenant.task, { voiceNotes: tenant.voiceNotes === true }),
    tenant.setup && setupContext(tenant.setup),
    tenant.plan && planContext(tenant.plan),
    tenant.tracker && trackerContext(tenant.tracker),
    tenant.notes?.length && notesContext(tenant.notes),
    tenant.library?.length && libraryContext(tenant.library),
    tenant.bar && barContext(tenant.bar),
    memories && `What you remember (from past conversations; it may be out of date, and the owner's word wins):\n${memories}`,
    tenant.recentMemories?.length && recentMemoriesContext(tenant.recentMemories),
    (tenant.profile.trim() || tenant.account?.about.trim() || memories) && BACKGROUND_ONLY,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    workspace_id: tenant.workspaceId,
    workspace_name: tenant.workspaceName,
    user_id: tenant.userId,
    composio_user_id: tenant.composioUserId,
    composio_toolkits: JSON.stringify(tenant.composioToolkits),
    agent_profile: tenant.profile,
    business_context: tenant.profile,
    agent_instructions: tenant.agentInstructions,
    memories,
    project_name: project?.name ?? "",
    project_instructions: project?.instructions ?? "",
    personal_guardrail: guardrail,
    system_context: system,
    browser_context: tenant.browserContext ?? "",
  };
}

/**
 * Who the agent is to the member: the name they kept and how it talks with them, or that it has
 * no name of its own yet. On calls it's introduced by its starting name, so it says so rather
 * than denying the name the member just heard.
 */
export function selfContext(self: NonNullable<AgentTenantContext["self"]>): string {
  const offered = self.naming === false ? "" : "; if they offer you one, suggest it with propose_agent (identity) so they can keep it";
  return [
    self.name
      ? `Who you are to them: you go by ${self.name}.`
      : self.callName
        ? `You don't have a name of your own with them yet: on calls you're introduced as ${self.callName}, this agent's starting name, not one they chose for you. If they ask, say that plainly${offered}. Never make up another.`
        : `You don't have a name of your own with them yet. If they ask, say so plainly${offered}. Never make one up.`,
    self.manner && `How you talk with them, in your own words: ${self.manner}`,
    (self.name || self.manner) && "Let it show in how you say things, never in how much you say, and never make a show of it.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * How the member is talking on this turn. On a call, a voice front greets them, reads out the
 * gist of each reply and the steps it reports, and shows its cards, so the reply is written for
 * the ear and doesn't greet them again. A voice message gets a voice note back: the reply's
 * first two sentences, spoken (src/lib/voice/notes.ts), so those carry the gist.
 */
export function modalityContext(modality: NonNullable<AgentTenantContext["modality"]>): string {
  if (modality === "voice_note") {
    return [
      "The member sent this as a voice message, so it was spoken: expect speech-to-text slips.",
      "They'll hear the start of your reply as a voice note, with the text underneath: your first two sentences, under about 50 words together, are what they hear, so put the gist there, in plain spoken words.",
      "Details, links, lists, and choices go after them, in writing.",
    ].join(" ");
  }
  return [
    "The member is on a live voice call with you. A voice reads out the gist of your reply and the steps you report, and shows your cards on their screen; their words reach you as they said them (expect speech-to-text slips).",
    "The voice has already greeted them: don't open with \"Hey!\" or any greeting, or with how you'll work together, even where a skill or setup says to. Lead with the one or two sentences that matter, written to be heard; put details, lists, and choices in your cards or below that.",
    "Ask one thing at a time, as on a phone call: at most one question a reply, in one sentence (fold choices into it: \"Is it A, B, or something else?\"), with no second or follow-up question. End your reply on that question.",
    "They're waiting on the line, so write your reply first and keep your books after it (update_plan, remember): the voice reads your reply the moment it's written. Once your books are kept you're done: don't write your reply again or add to it.",
  ].join(" ");
}

/** The member's keep/pass calls lately: their standard in practice, for the agent to aim at. */
function barContext(bar: NonNullable<AgentTenantContext["bar"]>): string {
  const batch = bar.lastBatch;
  const inBatch = new Set(batch?.items.map((i) => i.title) ?? []);
  const passes = bar.passes
    .filter((p) => !inBatch.has(p.title))
    .map((p) => `- ${p.title}${p.reason ? ` (${p.reason})` : ""}`)
    .join("\n");
  return [
    bar.judged > 0 && `How you're doing against the member's bar: they kept ${bar.kept} of the ${bar.judged} results they judged in the last ${bar.days} days.`,
    batch && missedBatchContext(batch),
    passes && `What they passed on lately, and why (their standard; don't bring them more like these):\n${passes}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The last results the member judged missed their bar: before looking for more like them, the
 * agent asks what to look for instead, unless the member has already said.
 */
function missedBatchContext(batch: NonNullable<NonNullable<AgentTenantContext["bar"]>["lastBatch"]>): string {
  const items = batch.items.map((i) => `- ${i.verdict === "keep" ? "Kept" : "Passed"}: ${i.title}${i.reason ? ` (${i.reason})` : ""}`).join("\n");
  const since = batch.since.map((s) => `- "${s}"`).join("\n");
  return [
    `The last results you brought them missed their bar: they passed on ${batch.kept ? `${batch.judged - batch.kept} of the ${batch.judged}` : `all ${batch.judged}`}.\n${items}`,
    "Before you look for more like these (even when they ask you to find more, and in a scheduled run), ask them what to look for instead: one ask_user with 2-4 concrete readings drawn from what they passed on and why, your best guess first (they can always answer in their own words). Call it last and stop. When they tell you, remember it in one line.",
    "If they've already told you what to look for instead (earlier in this chat, or in what they've said since, below), don't ask: say in a few words what you'll change, and go ahead.",
    since ? `What they've said in other chats since then:\n${since}` : "They haven't said anything in other chats since then.",
  ].join("\n");
}

/** Plan steps as the agent's context lists them, under what done looks like when it said. */
function planLines(steps: { text: string; status: string; note?: string | null }[], goal: string | null | undefined): string {
  const lines = steps.map((s) => `- [${s.status}] ${s.text}${s.note ? ` (${s.note})` : ""}`);
  return [goal && `Done means: ${goal}`, ...lines].filter(Boolean).join("\n");
}

/** This conversation is the agent's setup interview: its checklist so far. */
function setupContext(setup: NonNullable<AgentTenantContext["setup"]>): string {
  return [
    "This conversation is this agent's setup interview with the member.",
    setup.plan.length
      ? `Setup checklist so far:\n${planLines(setup.plan, setup.goal)}`
      : [setup.goal && `Done means: ${setup.goal}`, "There's no setup checklist yet; write one with update_plan."].filter(Boolean).join("\n"),
    "Keep the checklist current with update_plan as steps finish or are skipped.",
    setup.instructions &&
      `How to run the setup interview (until they apply your proposal, carry on from the current step; you're still setting up, not doing the job):\n${setup.instructions}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const NOTES_BUDGET = 3000;

/** Reference rows kept in view in every chat (e.g. interview stories), fields included, within a budget. */
function notesContext(notes: NonNullable<AgentTenantContext["notes"]>): string {
  const lines: string[] = [];
  let used = 0;
  for (const n of notes) {
    const fields = Object.entries(n.fields)
      .filter(([, v]) => typeof v === "string" || typeof v === "number")
      .map(([k, v]) => `${k}: ${String(v).replace(/\s+/g, " ").trim()}`)
      .join("; ");
    const line = `- [${n.collection}] ${n.title}${fields ? ` (${fields})` : ""}`;
    if (used + line.length > NOTES_BUDGET) break;
    lines.push(line);
    used += line.length;
  }
  return `The member's saved reference notes (from their tracker; use them when they fit, e.g. stories in interview prep):\n${lines.join("\n")}`;
}

const LIBRARY_CHARS = 4000;

/**
 * The member's Library: docs and sheets this agent made for them and links they filed. Listed so
 * the agent goes back to the one it already made (the job tracker sheet) instead of a new copy.
 */
export function libraryContext(items: NonNullable<AgentTenantContext["library"]>): string {
  let budget = LIBRARY_CHARS;
  const lines: string[] = [];
  for (const item of items) {
    const line = `- ${item.pinned ? "[pinned] " : ""}${item.title.replace(/\s+/g, " ").trim()} | ${item.kind} | ${item.url}`;
    if (line.length > budget) break;
    budget -= line.length + 1;
    lines.push(line);
  }
  return `The member's Library (docs you made for them and links they filed; title | kind | link; pinned first, then most recent). When they ask for something one of these already covers, open and update that one rather than making a new copy, and give them its link:\n${lines.join("\n")}`;
}

/**
 * The task this conversation works on: what it's for, and the plan so far. With `voiceNotes`,
 * a run's news comes back as a voice note that says its report_run summary.
 */
export function taskContext(task: NonNullable<AgentTenantContext["task"]>, { voiceNotes = false }: { voiceNotes?: boolean } = {}): string {
  return [
    `This conversation works on the member's task "${task.title}". Each run continues it.`,
    task.instructions.trim() && `Task brief:\n${task.instructions.trim()}`,
    task.plan.length
      ? `Plan so far:\n${planLines(task.plan, task.goal)}`
      : task.goal
        ? `There's no plan yet.\nDone means: ${task.goal}\nIf the task has several steps, write a plan toward that with update_plan.`
        : "There's no plan yet. If the task has several steps, write one with update_plan, with what done looks like as its goal.",
    // The member can set or change it on the task page, so it's theirs as much as the agent's.
    task.goal && "The task's goal stays as it is when you leave update_plan's goal empty; give one only if the member asks to change what done means.",
    "Keep the plan current with update_plan whenever a step starts, finishes, gets blocked, or needs the member.",
    "When this run's work is done, call report_run once: nothing_new if you found nothing worth their attention, update if there's something to read, needs_you if they must decide or act. They're only notified for update and needs_you.",
    voiceNotes &&
      "For update and needs_you, they hear your report_run summary as a voice note: write it to be heard, in two or three short spoken sentences with the best result first, with no symbols, lists, or links, in 300 characters at most.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The plan the agent keeps for the work in this conversation (neither a task's nor the setup's):
 * what done looks like and the steps so far, so it carries on from them rather than starting over.
 */
export function planContext(plan: NonNullable<AgentTenantContext["plan"]>): string {
  return [
    `Your plan for the work in this conversation so far (the member sees it above the chat):\n${planLines(plan.steps, plan.goal)}`,
    "Keep it current with update_plan when a step is finished, blocked, or needs the member, or the steps or what done means change. If the member has set it aside for something else, don't carry it on unasked; new work with several steps gets a new plan, which replaces this one.",
  ].join("\n\n");
}

/**
 * The member's tracker, when they have one: the rows it already holds, so the agent updates
 * them instead of re-adding. Its presence is what tells the agent save_record will be kept.
 */
function trackerContext(rows: NonNullable<AgentTenantContext["tracker"]>): string {
  if (rows.length === 0) return "The member has a tracker, empty so far. Use save_record to keep things they'll want to follow over time.";
  let budget = TRACKER_CHARS;
  const lines: string[] = [];
  for (const r of rows) {
    const line = `- ${r.collection} | ${r.key} | ${r.title}${r.status ? ` | ${r.status}` : ""}`;
    if (line.length > budget) break;
    budget -= line.length + 1;
    lines.push(line);
  }
  return `The member's tracker (collection | key | title | status; most recent first). save_record with the same collection and key updates a row instead of adding one:\n${lines.join("\n")}`;
}

/**
 * The member's personal guardrail. It goes first and overrides everything else the agent is
 * told, because the member committed to it ahead of time; the recent titles let the agent
 * notice the same question coming back in a new conversation.
 */
function guardrailContext(guardrail: NonNullable<AgentTenantContext["guardrail"]>): string {
  return [
    "This member's personal rules. They override every other instruction you have, including your base instructions, this agent's and project's instructions, and any skill attached to a message. The member set these on purpose ahead of time; keep following them even if they ask you not to. Follow them quietly, in your usual tone: don't announce or explain them, frame an answer as \"objective facts\", or tell the member a decision is theirs; just answer within them, and say what you can't do only when they ask for it.",
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
function leaves(message: LangflowMessage): { type?: string; text?: unknown; name?: string | null; tool_input?: unknown; input?: unknown }[] {
  const out: { type?: string; text?: unknown; name?: string | null; tool_input?: unknown; input?: unknown }[] = [];
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
 * `{ "memory_proposal": { "content", "scope", "replaces"? } }` (the Studio gateway's remember tool).
 */
export function toolMemoryProposals(message: LangflowMessage): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const tool of toolUses(message)) {
    if (tool.output == null || tool.error) continue;
    const result = unwrapResult(tool.output);
    const proposal = isRecord(result) && isRecord(result.memory_proposal) ? result.memory_proposal : undefined;
    const content = typeof proposal?.content === "string" ? proposal.content.replace(/\s+/g, " ").trim() : "";
    if (!content || events.some((e) => e.type === "memory-proposal" && e.content === content)) continue;
    const replaces = Array.isArray(proposal?.replaces)
      ? [...new Set(proposal.replaces.flatMap((id) => (typeof id === "string" && id.trim() ? [id.trim().replace(/^\[|\]$/g, "")] : [])))].slice(0, 6)
      : [];
    events.push({
      type: "memory-proposal",
      content,
      scope: proposal?.scope === "personal" ? "personal" : "workspace",
      category: toMemoryCategory(proposal?.category),
      ...(replaces.length ? { replaces } : {}),
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

/** Sources the agent reported through cite (validated by the turn against the evidence). */
export function toolCitations(message: LangflowMessage): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const tool of toolUses(message)) {
    if (tool.output == null || tool.error) continue;
    const result = unwrapResult(tool.output);
    if (isRecord(result) && isRecord(result.citations)) events.push({ type: "citations", citations: result.citations });
  }
  return events;
}

/** Charts, key numbers, and tables an investigation reported through report_visual. */
export function toolVisuals(message: LangflowMessage): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const tool of toolUses(message)) {
    if (tool.output == null || tool.error) continue;
    const result = unwrapResult(tool.output);
    if (isRecord(result) && isRecord(result.visual)) events.push({ type: "visual", visual: result.visual });
  }
  return events;
}

/** Studio Browser's tools (the hosted browser), whose results carry the conversation's browser. */
const BROWSER_TOOLS = new Set(["start", "navigate", "act", "observe", "extract", "end"]);

/**
 * The conversation's browser as its tools last reported it: Studio Browser puts the session id
 * first in each result (start's own result has it too), and end means it's gone. Only the id is
 * read; nothing else about the browser leaves its result.
 */
export function toolBrowserSessions(message: LangflowMessage): AgentEvent[] {
  let found: { sessionId: string | null } | null = null;
  for (const call of toCalls(message)) {
    if (!BROWSER_TOOLS.has(call.name) || call.error || call.output == null) continue;
    if (call.name === "end") {
      found = { sessionId: null };
      continue;
    }
    const result = unwrapResult(call.output);
    if (!isRecord(result)) continue;
    const id = typeof result.studioBrowserSession === "string" ? result.studioBrowserSession : call.name === "start" && isRecord(result.data) && typeof result.data.sessionId === "string" ? result.data.sessionId : null;
    if (id) found = { sessionId: id };
  }
  return found ? [{ type: "browser-session", ...found }] : [];
}

/** What the message's tool calls returned for each link, for checking citations. */
export function toolEvidence(message: LangflowMessage): AgentEvent[] {
  const items = evidenceFor(toCalls(message));
  return items.length > 0 ? [{ type: "evidence", items }] : [];
}

/**
 * Forms (show_form), proposed agent setups (propose_agent), proposed merges of remembered facts
 * (merge_memories), offers to talk on a call (offer_call), requests for a login or card
 * (request_secret), and the browser handed to the member (hand_browser, read from that tool alone)
 * for the member (validated, and offers and hand-offs kept only where the member could take them,
 * by the turn).
 */
export function toolUi(message: LangflowMessage): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const tool of toolUses(message)) {
    if (tool.output == null || tool.error) continue;
    const result = unwrapResult(tool.output);
    if (!isRecord(result)) continue;
    if (isRecord(result.form)) events.push({ type: "ui", block: { form: result.form } });
    else if (isRecord(result.proposal)) events.push({ type: "ui", block: { proposal: result.proposal } });
    else if (isRecord(result.memory_merge)) events.push({ type: "ui", block: { memory_merge: result.memory_merge } });
    else if (isRecord(result.offer_call)) events.push({ type: "ui", block: { offer_call: result.offer_call } });
    else if (isRecord(result.secret_request)) events.push({ type: "ui", block: { secret_request: result.secret_request } });
    else if (tool.name === "hand_browser" && isRecord(result.hand_browser)) events.push({ type: "ui", block: { hand_browser: result.hand_browser } });
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

/**
 * Plan updates, tracker rows, and Library links the agent reported through update_plan,
 * save_record, and file_link (validated and saved by the turn, under the member's session).
 */
export function toolTaskUpdates(message: LangflowMessage): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const tool of toolUses(message)) {
    if (tool.output == null || tool.error) continue;
    const result = unwrapResult(tool.output);
    if (!isRecord(result)) continue;
    if (isRecord(result.plan_update)) events.push({ type: "plan-update", plan: result.plan_update.steps, goal: result.plan_update.goal });
    if (isRecord(result.record)) events.push({ type: "record", record: result.record });
    if (isRecord(result.library_item)) events.push({ type: "library-item", item: result.library_item });
    if (isRecord(result.run_report)) events.push({ type: "run-report", report: result.run_report });
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
export function approvalFor(data: unknown): { summary: string; app?: string; details: [string, string][]; actions: ApprovalAction[] } {
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
  return { summary, app, details, actions: approvalActions(data) };
}

/** The gateway's take_action: an action that changes something, paused until the member approves. */
const TAKE_ACTION = "take_action";
const COMPOSIO_SLUG = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;

/**
 * Everything approving this pause would run, across all its action requests, the way the gateway
 * will run it once approved (tool_gateway.py `route()`): nested execute_tool calls unwrapped
 * (three deep), a bare Composio slug sent as one action, and every tool of a multi-execute. An
 * action the gateway couldn't run as written (arguments that aren't JSON, a request to some other
 * tool) comes back under a name no rule allows, so it stays a tap.
 */
export function approvalActions(data: unknown): ApprovalAction[] {
  const requests = isRecord(data) && Array.isArray(data.action_requests) ? data.action_requests : [];
  return requests.flatMap((request): ApprovalAction[] => {
    if (!isRecord(request) || request.name !== TAKE_ACTION || !isRecord(request.args)) {
      return [{ tool: isRecord(request) && typeof request.name === "string" ? request.name : "", arguments: isRecord(request) ? request.args : null }];
    }
    return routedActions(request.args.tool_name, request.args.arguments);
  });
}

/** JSON text as the gateway reads it (an empty string is no arguments); undefined when it isn't JSON. */
function gatewayJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (!value.trim()) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function routedActions(toolName: unknown, raw: unknown): ApprovalAction[] {
  let name = typeof toolName === "string" ? toolName : "";
  let args = raw;
  for (let i = 0; i < 3 && name === "execute_tool"; i++) {
    const inner = gatewayJson(args);
    if (!isRecord(inner) || typeof inner.tool_name !== "string") break;
    name = inner.tool_name;
    args = inner.arguments || {};
  }
  const parsed = gatewayJson(args);
  if (COMPOSIO_SLUG.test(name)) return [{ tool: parsed === undefined ? "" : name, arguments: parsed ?? null }];
  if (name === "composio_multi_execute_tool") {
    const tools = isRecord(parsed) ? parsed.tools : undefined;
    if (!Array.isArray(tools) || tools.length === 0) return [{ tool: "", arguments: null }];
    return tools.map((t) => {
      const slug = isRecord(t) && typeof t.tool_slug === "string" ? t.tool_slug.toUpperCase() : "";
      const inner = isRecord(t) ? gatewayJson(t.arguments ?? {}) : undefined;
      return { tool: inner === undefined ? "" : slug, arguments: inner ?? null };
    });
  }
  return [{ tool: name, arguments: parsed ?? null }];
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

/**
 * Which entries of a reply are the agent's opening lines: short text followed by a tool call
 * that does work. Text followed only by calls that report on the answer (cite, remember, …) or
 * keep the agent's books (its plan) is the answer itself, and long text never reads as an
 * opening line.
 */
export function openingLineIndexes(entries: { type?: string; text?: unknown; name?: string | null; tool_input?: unknown; input?: unknown }[]): number[] {
  // From the end back: a short line is an opening line when work comes next, past any bookkeeping
  // and other opening lines; the reply (or the end) comes next otherwise.
  const out: number[] = [];
  let workNext = false;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const l = entries[i];
    if (l.type === "tool_use") {
      if (!keepsBooks(l.name ?? "tool", l.tool_input ?? l.input)) workNext = true;
    } else if (l.type === "text" && typeof l.text === "string") {
      if (workNext && opensWork(l.text)) out.unshift(i);
      else workNext = false;
    }
  }
  return out;
}

/** The agent's opening lines in a bot message. */
export function leadingNotes(message: LangflowMessage): string[] {
  const all = leaves(message);
  return openingLineIndexes(all).map((i) => (all[i].text as string).trim());
}

/**
 * A bot message's text with the parts on either side of each tool call kept apart (see
 * seamBetween in src/lib/chat/seam.ts). Langflow's text is every part joined end to end; its
 * content blocks keep the parts, in order, with the tool calls between them, so a seam is only
 * ever placed where a tool call really fell, never guessed from the prose.
 */
export function separateAroundTools(text: string, message: LangflowMessage): string {
  let out = text;
  let from = 0;
  let previous: string | null = null;
  let toolSince = false;
  for (const leaf of leaves(message)) {
    if (leaf.type === "tool_use") {
      if (previous !== null) toolSince = true;
      continue;
    }
    if (leaf.type !== "text" || typeof leaf.text !== "string" || !leaf.text) continue;
    if (previous !== null && toolSince) {
      const at = out.indexOf(previous + leaf.text, from);
      if (at >= 0) {
        const cut = at + previous.length;
        const seam = seamBetween(previous, leaf.text);
        out = out.slice(0, cut) + seam + out.slice(cut);
        from = cut + seam.length;
      }
    }
    previous = leaf.text;
    toolSince = false;
  }
  return out;
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

const STORED_PAGE = 1000;

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

  // The flow's own chat memory of one conversation, oldest first.
  async function storedMessages(tenant: Pick<AgentTenantContext, "workspaceId" | "composioUserId">, conversationId: string) {
    const url = new URL(endpoint(config, "api/v1/monitor/messages"));
    url.searchParams.set("flow_id", config.flowId);
    url.searchParams.set("session_id", langflowSessionId(tenant, conversationId));
    url.searchParams.set("order", "ASC");
    url.searchParams.set("limit", String(STORED_PAGE));
    const response = await doFetch(url.toString(), { headers: headers(config) });
    if (!response.ok) throw errorFor(response.status);
    return ((await response.json().catch(() => [])) as { id?: unknown; sender?: unknown }[]).filter(
      (m): m is { id: string; sender?: unknown } => typeof m?.id === "string",
    );
  }

  async function deleteMessages(ids: string[]) {
    if (ids.length === 0) return;
    const removed = await doFetch(endpoint(config, "api/v1/monitor/messages"), {
      method: "DELETE",
      headers: { ...headers(config), "Content-Type": "application/json" },
      body: JSON.stringify(ids),
    });
    if (!removed.ok) throw errorFor(removed.status);
  }

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

      yield { type: "trace", traceId: jobId };

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
        // Notes followed only by calls that keep the agent's books (see keepsBooks) may be part of
        // its reply after all ("Hey! …", then updating its plan, then its question). They are once
        // more of the reply is released or the run ends, and are streamed then, where they were
        // written; real work next makes them opening lines after all. Streamed, never replaced, so
        // a run resumed after an approval keeps what was said before it.
        let held: string[] = [];
        const keepHeld = (more: boolean): AgentEvent[] => {
          if (held.length === 0) return [];
          const lines = held;
          held = [];
          const text = `${shownText && !/\s$/.test(shownText) ? "\n\n" : ""}${lines.join("\n\n")}${more ? "\n\n" : ""}`;
          shownText += text;
          return [...lines.map((line): AgentEvent => ({ type: "note-reply", text: line })), { type: "text-delta", text }];
        };
        // Text streamed after a tool call is a new part of the reply: keep it apart from the part
        // before the call (see seamBetween), as separateAroundTools does for the final text.
        let afterTool = false;
        const stream = (text: string): AgentEvent => {
          const seam = afterTool ? seamBetween(shownText, text) : "";
          if (text) afterTool = false;
          shownText += seam + text;
          return { type: "text-delta", text: seam + text };
        };
        let lastBot: LangflowMessage | undefined;
        const seenArtifacts = new Set<string>();
        const seenProposals = new Set<string>();
        const seenReports = new Set<string>();
        const newReports = (message: LangflowMessage) =>
          [
            ...toolTimelines(message),
            ...toolVisuals(message),
            ...toolCitations(message),
            ...toolQuestions(message),
            ...toolUi(message),
            ...toolTaskUpdates(message),
            ...toolBrowserSessions(message),
          ].filter((t) => {
            const key = JSON.stringify(t);
            if (seenReports.has(key)) return false;
            seenReports.add(key);
            return true;
          });
        // Evidence only grows as tools return; send what's new for each link.
        const evidenceSize = new Map<string, number>();
        const newEvidence = (message: LangflowMessage): AgentEvent[] => {
          const items = toolEvidence(message).flatMap((e) => (e.type === "evidence" ? e.items : []));
          const fresh = items.filter((i) => (evidenceSize.get(i.url) ?? -1) < i.text.length);
          for (const i of fresh) evidenceSize.set(i.url, i.text.length);
          return fresh.length > 0 ? [{ type: "evidence", items: fresh }] : [];
        };
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
                  yield stream(chunk);
                } else {
                  pending += chunk;
                  if (pending.length > OPENING_LINE_MAX || pending.includes("\n\n")) {
                    releasing = true;
                    yield* keepHeld(true);
                    yield stream(pending);
                    pending = "";
                  }
                }
              }
            } else if (event === "add_message") {
              const message = data as LangflowMessage;
              if (!isBot(message)) continue;
              lastBot = message;
              const uses = toolUses(message);
              if (uses.length > toolCount) {
                const fresh = uses.slice(toolCount);
                toolCount = uses.length;
                const bookkeeping = fresh.every((t) => keepsBooks(t.name ?? "tool", t.tool_input ?? t.input));
                // Text before a call that only cites or remembers is the answer, not an opening line.
                if (fresh.every((t) => reportsOnAnswer(t.name ?? "tool", t.tool_input ?? t.input))) {
                  if (pending) {
                    yield* keepHeld(true);
                    yield stream(pending);
                  }
                } else if (pending.trim()) {
                  notes.push(pending.trim());
                  yield { type: "note", text: pending.trim() };
                  if (bookkeeping) held.push(pending.trim());
                  else held = [];
                } else if (!bookkeeping) {
                  held = [];
                }
                pending = "";
                releasing = false;
                afterTool = true;
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
              yield* newEvidence(message);
              yield* newReports(message);
              for (const p of toolMemoryProposals(message)) {
                if (p.type === "memory-proposal" && !seenProposals.has(p.content)) {
                  seenProposals.add(p.content);
                  yield p;
                }
              }
              const answer = typeof message.text === "string" ? withoutNotes(separateAroundTools(message.text, message), notes) : "";
              if (!tokens && answer !== shownText && (answer || shownText)) {
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
              held = [];
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
              yield* keepHeld(Boolean(pending));
              if (pending) {
                yield stream(pending);
                pending = "";
              }
              const final = resultMessage((data as { result?: unknown })?.result) ?? lastBot;
              const text = typeof final?.text === "string" ? withoutNotes(separateAroundTools(final.text, final), notes) : "";
              if (text && text !== shownText && !tokens) yield { type: "message", text };
              if (final) {
                yield* activityFor(final, lastBot?.id ?? final.id ?? "message");
                // A suggestion made right before the end may only arrive in the result message.
                yield* newEvidence(final);
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
        yield* keepHeld(Boolean(pending));
        if (pending) yield stream(pending);
        if (!shownText) throw new AgentError("The agent stopped before finishing.");
      } finally {
        input.signal.removeEventListener("abort", onAbort);
      }
    },

    async rewind({ tenant, conversationId }, turns) {
      if (turns < 1) return;
      const messages = await storedMessages(tenant, conversationId);
      const users = messages.flatMap((m, i) => (m.sender === "User" ? [i] : []));
      if (users.length === 0) return;
      const from = users[Math.max(0, users.length - turns)];
      await deleteMessages(messages.slice(from).map((m) => m.id));
    },

    async forget({ tenant, conversationId }) {
      // A long chat may hold more than one page; each pass deletes what it read.
      for (let pass = 0; pass < 20; pass++) {
        const messages = await storedMessages(tenant, conversationId);
        if (messages.length === 0) return;
        await deleteMessages(messages.map((m) => m.id));
        if (messages.length < STORED_PAGE) return;
      }
    },

    async discard(state) {
      const paused = pausedJob(state);
      if (paused) await stopJob(paused.jobId);
    },
  };
}

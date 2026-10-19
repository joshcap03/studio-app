import { writeFileSync } from "node:fs";
import { createLangflowAdapter, type LangflowConfig } from "@/lib/agent/langflow";
import type { AgentAttachment, AgentEvent, AgentTenantContext } from "@/lib/agent/types";
import { buildQuestions } from "@/lib/chat/questions";
import { buildUiBlock } from "@/lib/chat/ui";
import { formAnswerText, type FormValues } from "@/lib/chat/ui-answer";
import { renderSkillMessage } from "@/lib/skills/render";
import { setupSkill } from "@/lib/skills/setup";
import { planFromAgent } from "@/lib/tasks/agent";
import { templateById } from "@/lib/templates";
import type { AgentProposal, UiForm } from "@/lib/types";

// Shared by the setup interview evals: runs a setup against a live flow with a real model
// (LANGFLOW_TEST_* env), sent the way the app sends it. The first message is the "Set up this
// agent" skill with no text of its own, later ones are the member's answers, and the run's
// context (setup checklist, tracker, agent files, memory) is kept up to date between turns the
// way the app keeps it. A scripted member answers whatever the agent shows: plain questions with
// the next part of their story, cards with drafted answers or their own words.
//
// Point these at a test flow, never the live one: for production, make one with
// `python3 langflow/install.py <flow> --copy "Studio eval"` (add --strip-apps for one that can't
// act on real accounts, though it then can't search for a real trial run either).
// LANGFLOW_TEST_TWEAKS (JSON, like LANGFLOW_TWEAKS) overrides the tweaks; by default they're the
// node ids install.py gives, plus the flow's Chat Input for files (looked up from the flow).

const baseUrl = process.env.LANGFLOW_TEST_BASE_URL;
const apiKey = process.env.LANGFLOW_TEST_API_KEY;
const flowId = process.env.LANGFLOW_TEST_FLOW_ID;
export const liveFlow = Boolean(baseUrl && apiKey && flowId);

const DEFAULT_TWEAKS: Record<string, unknown> = {
  "WorkspaceContext-studio": { workspace_context: "{{system_context}}" },
  "MemberApps-studio": { member_id: "{{composio_user_id}}", toolkits: "{{composio_toolkits}}" },
};

/** Someone setting up an agent, scripted. Made up: no real people or businesses. */
export interface ScriptedMember {
  templateId: string;
  /** The agent's name, as the member would have it. */
  agentName: string;
  name: string;
  /** How they answer discovery's open questions, in order, as a real person would. */
  discovery: string[];
  /** The agent giving its own read of their problem and where it could help, as discovery ends. */
  advice: RegExp;
  /** Their answer to that read. */
  agree: string;
  /** Crisp answers of their own where a card lets them say something else, by field label. */
  bar: [RegExp, string][];
  /** Why they pass on trial results: distinctive enough to find in their bar afterwards. */
  passReason: string;
  /** Their answers to other open text fields, by label; undefined leaves a field to its prefill. */
  text?: (label: string) => string | undefined;
  /** What they say to a plain request in the agent's reply (e.g. "paste a few rows here"), if anything. */
  reply?: (agentText: string) => string | undefined;
  /** A file they add when a card asks for one (e.g. a résumé). */
  file?: { name: string; mimeType: string; content: string };
  /** A personal guardrail, as a member would write it. */
  guardrail?: string;
}

export type Turn = {
  message: string;
  events: AgentEvent[];
  reply: string;
  form: UiForm | null;
  proposal: AgentProposal | null;
  rawProposal: unknown;
  /** How long the run took, start to last event. */
  ms: number;
};

export function replyOf(events: AgentEvent[]): string {
  const messages = events.filter((e): e is Extract<AgentEvent, { type: "message" }> => e.type === "message");
  if (messages.length) return messages[messages.length - 1].text;
  return events
    .filter((e): e is Extract<AgentEvent, { type: "text-delta" }> => e.type === "text-delta")
    .map((e) => e.text)
    .join("");
}

export function records(events: AgentEvent[], collection: string): Record<string, unknown>[] {
  return events
    .filter((e): e is Extract<AgentEvent, { type: "record" }> => e.type === "record")
    .map((e) => e.record as Record<string, unknown>)
    .filter((r) => r && typeof r === "object" && String(r.collection).toLowerCase() === collection);
}

export const describeTurn = (turn: Turn) => `reply: ${turn.reply.slice(0, 600)}\nevents: ${turn.events.map((e) => e.type).join(", ")}`;

/**
 * Whether the proposal's instructions carry the bar the member ranked: most of the criteria from
 * their last ranking answer ("…(most important first): 1. A; 2. B"), each found by its first words.
 * The agent designs the bar's form itself, so the bar's words are theirs, not a fixed script's.
 */
export function carriesRankedBar(turns: Turn[], instructions: string): boolean {
  const ranking = [...turns].reverse().find((t) => /most important first\)?:/i.test(t.message))?.message ?? "";
  const criteria = [...ranking.matchAll(/\d+\.\s+([^;\n]+)/g)].map((m) => m[1].trim()).filter(Boolean);
  if (criteria.length === 0) return false;
  const text = instructions.toLowerCase().replace(/[‘’]/g, "'");
  const found = criteria.filter((c) => text.includes(c.toLowerCase().replace(/[‘’]/g, "'").split(/\s+/).slice(0, 4).join(" ")));
  return found.length * 2 >= criteria.length;
}

/**
 * The checklist sizes the agent reported, turn by turn, and the turn where the member confirmed
 * their bar (sent their ranking). A setup lists only what it knows: two steps to start, the rest
 * once it understands their problem and bar.
 */
export function checklistGrowth(turns: Turn[]): { first: number | null; early: string[]; barAt: number } {
  const plans = turns.map((t) => {
    const updates = t.events.filter((e): e is Extract<AgentEvent, { type: "plan-update" }> => e.type === "plan-update");
    return updates.length ? planFromAgent(updates[updates.length - 1].plan) : null;
  });
  // The bar is confirmed on the turn the agent marks its bar step done; failing that, at the
  // member's last ranking, or the proposal.
  const barDone = plans.findIndex((p) => p?.some((s) => /success|\bbar\b|judg/i.test(s.text) && s.status === "done") ?? false);
  const lastRanking = turns.map((t) => /most important first\)?:/i.test(t.message)).lastIndexOf(true);
  const proposal = turns.findIndex((t) => t.proposal);
  const barAt = [barDone, lastRanking, proposal].find((i) => i >= 0) ?? -1;
  const until = barAt === -1 ? plans.length : barAt;
  // Before the bar, only what getting to it needs: their problem, what a fair trial needs (e.g. a
  // résumé), the trial, the bar itself, and the proposal it ends in. Anything else is later setup.
  const known = /understand|after|problem|hard|résumé|resume|file|background|trial|success|bar\b|judg|propos/i;
  const later = /\b(connect|apps?|tools?|stories|define the search|search settings|cadence|schedule|rhythm|when i work|chase day|your business)\b/i;
  const early = plans
    .slice(0, until)
    .flatMap((p) => p ?? [])
    .map((s) => s.text)
    .filter((text, i, all) => (later.test(text) || !known.test(text)) && all.indexOf(text) === i);
  return { first: plans.find((p) => p !== null)?.length ?? null, early, barAt };
}

/** Median and 90th percentile of how long turns took, in seconds, for the eval log. */
export function timing(turns: Turn[]): { turns: number; p50: number; p90: number; max: number } {
  const ms = turns.map((t) => t.ms).sort((a, b) => a - b);
  const at = (q: number) => (ms.length ? Math.round(ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] / 100) / 10 : 0);
  return { turns: ms.length, p50: at(0.5), p90: at(0.9), max: at(1) };
}

/** One member's setup interview, turn by turn. */
export function setupSession(member: ScriptedMember) {
  const template = templateById(member.templateId)!;
  const conversationId = crypto.randomUUID();
  const turns: Turn[] = [];
  const tenant: AgentTenantContext = {
    workspaceId: crypto.randomUUID(),
    workspaceName: member.agentName,
    userId: crypto.randomUUID(),
    composioUserId: `eval_${crypto.randomUUID()}`,
    account: { name: member.name, about: "" },
    composioToolkits: {},
    profile: "",
    agentInstructions: template.instructions,
    memories: [],
    task: null,
    tracker: [],
    // The first run has no setup yet: the app marks it under way after that run starts. From
    // then on the setup instructions ride along (see send()).
    setup: null,
    notes: [],
    agentFiles: [],
    guardrail: member.guardrail ? { instructions: member.guardrail, recentChats: [] } : null,
  };
  let config: LangflowConfig | undefined;
  let discovered = 0;

  const file = (): AgentAttachment => ({
    id: crypto.randomUUID(),
    name: member.file!.name,
    mimeType: member.file!.mimeType,
    size: member.file!.content.length,
    read: async () => new Blob([member.file!.content], { type: member.file!.mimeType }),
  });

  async function tweaks(): Promise<unknown> {
    if (process.env.LANGFLOW_TEST_TWEAKS) return JSON.parse(process.env.LANGFLOW_TEST_TWEAKS) as unknown;
    const res = await fetch(`${baseUrl!.replace(/\/$/, "")}/api/v1/flows/${flowId}`, { headers: { "x-api-key": apiKey! } });
    if (!res.ok) throw new Error(`couldn't read the test flow (${res.status})`);
    const flow = (await res.json()) as { data: { nodes: { data: { id: string; type?: string } }[] } };
    const chatInput = flow.data.nodes.find((n) => n.data.type === "ChatInput");
    if (!chatInput) throw new Error("the test flow has no Chat Input");
    return { ...DEFAULT_TWEAKS, [chatInput.data.id]: { files: "{{files}}" } };
  }

  /** One turn, with the context updated afterwards the way the app would. */
  async function send(message: string, withFile = false): Promise<Turn> {
    config ??= { baseUrl: baseUrl!, apiKey: apiKey!, flowId: flowId!, stream: true, tweaks: await tweaks() };
    if (withFile && member.file && !tenant.agentFiles!.includes(member.file.name)) tenant.agentFiles!.push(member.file.name);
    const events: AgentEvent[] = [];
    const started = Date.now();
    for await (const e of createLangflowAdapter(config).run({
      conversationId,
      threadId: null,
      message,
      history: [],
      tenant,
      // Agent files ride along with every run once added (src/lib/chat/run.ts).
      attachments: member.file && tenant.agentFiles!.includes(member.file.name) ? [file()] : [],
      signal: AbortSignal.timeout(280_000),
    })) {
      events.push(e);
    }
    const ms = Date.now() - started;
    for (const e of events) {
      if (e.type === "plan-update") {
        const plan = planFromAgent(e.plan);
        if (plan) tenant.setup = { ...tenant.setup, plan: plan.map((s) => ({ text: s.text, status: s.status, note: s.note })) };
      } else if (e.type === "memory-proposal") {
        tenant.memories.push(e.content);
      }
    }
    for (const r of records(events, "stories")) {
      const key = String(r.key ?? "");
      const title = String(r.title ?? key);
      tenant.tracker = [...tenant.tracker!.filter((x) => x.key !== key), { collection: "stories", key, title, status: null }];
      tenant.notes = [...tenant.notes!.filter((n) => n.title !== title), { collection: "stories", title, fields: (r.fields as Record<string, unknown>) ?? {} }];
    }
    let form: UiForm | null = null;
    let proposal: AgentProposal | null = null;
    let rawProposal: unknown = null;
    for (const e of events) {
      if (e.type !== "ui") continue;
      const block = buildUiBlock(e.block);
      if (block?.kind === "form") form = block;
      if (block?.kind === "proposal") {
        proposal = block;
        rawProposal = (e.block as { proposal: unknown }).proposal;
      }
    }
    const turn = { message, events, reply: replyOf(events), form, proposal, rawProposal, ms };
    turns.push(turn);
    // As the app does once setup is under way (src/lib/workspace.ts): the setup skill stays in
    // view on every later run in this conversation.
    if (!tenant.setup?.instructions) tenant.setup = { plan: tenant.setup?.plan ?? [], instructions: setupSkill(member.templateId).instructions };
    return turn;
  }

  /** The first turn: the setup skill, with no text of the member's own. */
  function start(): Promise<Turn> {
    return send(renderSkillMessage(setupSkill(member.templateId), ""));
  }

  /** The member's reply to a plain question: the next part of their story, or a yes to a playback. */
  function talk(reply: string): string {
    const asked = member.reply?.(reply);
    if (asked) return asked;
    // Advice is a considered read with ways to help, not a passing "before I suggest anything".
    if (discovered >= 2 && reply.length > 250 && member.advice.test(reply)) return member.agree;
    if (discovered >= 2 && /\b(right|correct|accurate|sound right|fair|is that it|get that right)\?/i.test(reply)) return "Yes, that's exactly it.";
    return member.discovery[discovered++] ?? "Yes, that's right. Go on.";
  }

  const own = (label: string) => member.bar.find(([q]) => q.test(label))?.[1];

  /** The member's answers to a form: prefills as drafted, their own words where they have them. */
  function fill(form: UiForm): { values: FormValues; attachFile: boolean } {
    const values: FormValues = {};
    let attachFile = false;
    for (const f of form.fields) {
      switch (f.kind) {
        case "choice": {
          const mine = f.allowOther ? own(f.label) : undefined;
          values[f.id] = mine ? [mine] : f.prefill?.length ? f.prefill : [f.options[0].label];
          break;
        }
        case "multi_choice": {
          const mine = f.allowOther ? own(f.label) : undefined;
          const picked = f.prefill?.length ? f.prefill : f.options.slice(0, mine ? 2 : 3).map((o) => o.label);
          values[f.id] = mine ? [...picked, mine] : picked;
          break;
        }
        case "scale":
          values[f.id] = String(f.prefill ?? Math.ceil((f.steps * 3) / 4));
          break;
        case "rank":
          values[f.id] = f.prefill ?? f.options.map((o) => o.label);
          break;
        case "verdict":
          // Keeps the first two results, passes on the rest for one telling reason.
          values[f.id] = f.items.map((item, i): Record<string, string> =>
            i < 2 ? { id: item.id, verdict: "keep" } : { id: item.id, verdict: "pass", reason: member.passReason },
          );
          break;
        case "text":
        case "long_text": {
          const answer = f.prefill || own(f.label) || member.text?.(f.label);
          if (answer) values[f.id] = answer;
          else if (f.required) values[f.id] = "Nothing more to add.";
          break;
        }
        case "file":
          if (member.file) {
            values[f.id] = [member.file.name];
            attachFile = true;
          }
          break;
        case "list":
          if (f.prefill?.length) values[f.id] = f.prefill;
          break;
        case "connect":
          // Connecting is done in the card itself, not in the answer; the member skips it here.
          break;
      }
    }
    return { values, attachFile };
  }

  /** Answers what the last turn asked (a form, or ask_user's questions), as the member would. */
  async function answer(last: Turn): Promise<Turn> {
    if (last.form) {
      const { values, attachFile } = fill(last.form);
      return send(formAnswerText(last.form, values), attachFile);
    }
    const asked = last.events.find((e) => e.type === "questions");
    const questions = asked?.type === "questions" ? buildQuestions(asked.questions) : null;
    // A quick pick gets the first (recommended) option, unless it asks something they'd answer in their own words.
    const text = questions
      ? questions.map((q) => `${q.question} ${member.reply?.(q.question) ?? q.options[0].label}`).join("\n")
      : talk(last.reply);
    return send(text);
  }

  /**
   * Prints turn timing. SETUP_EVAL_LOG=<path> also writes the transcript and timing beside that
   * path, one file per member (e.g. x.job-search.json), for seeing what the model did.
   */
  function writeLog(label: string): void {
    const t = timing(turns);
    console.log(`${label}: ${t.turns} turns, p50 ${t.p50}s, p90 ${t.p90}s, max ${t.max}s`);
    const log = process.env.SETUP_EVAL_LOG;
    if (!log) return;
    const path = log.replace(/(\.json)?$/, `.${member.templateId}${member.guardrail ? ".guardrail" : ""}.json`);
    writeFileSync(path, JSON.stringify({ timing: t, turns: turns.map(({ events, ...rest }) => ({ ...rest, events: events.filter((e) => e.type !== "text-delta") })) }, null, 2));
  }

  return { tenant, turns, start, send, answer, writeLog, last: () => turns[turns.length - 1] };
}

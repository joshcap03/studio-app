import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { createLangflowAdapter, type LangflowConfig } from "@/lib/agent/langflow";
import type { AgentAttachment, AgentEvent, AgentTenantContext } from "@/lib/agent/types";
import { buildQuestions } from "@/lib/chat/questions";
import { buildUiBlock } from "@/lib/chat/ui";
import { formAnswerText, type FormValues } from "@/lib/chat/ui-answer";
import { renderSkillMessage } from "@/lib/skills/render";
import { setupSkill } from "@/lib/skills/setup";
import { planFromAgent } from "@/lib/tasks/agent";
import { taskScheduleSchema } from "@/lib/tasks/schedule";
import { templateById } from "@/lib/templates";
import type { AgentProposal, UiForm } from "@/lib/types";

// Eval of the Job search setup interview against a live flow with a real model (LANGFLOW_TEST_*
// env), sent the way the app sends it: the first message is the "Set up this agent" skill
// with no text of its own, later ones are the member's form answers, and the run's context
// (setup checklist, tracker, agent files, memory) is kept up to date between turns the way
// the app keeps it.
// A scripted member answers whatever card the agent shows. The checks look at the cards and
// structured events, not at the model's wording (apart from the greeting).
//
// The résumé is a made-up fixture. Point this at a test flow, never the live one: for
// production, make one with `python3 langflow/install.py <flow> --copy "Studio eval" --strip-apps`.
// LANGFLOW_TEST_TWEAKS (JSON, like LANGFLOW_TWEAKS) overrides the tweaks; by default they're the
// node ids install.py gives, plus the flow's Chat Input for files (looked up from the flow).

const baseUrl = process.env.LANGFLOW_TEST_BASE_URL;
const apiKey = process.env.LANGFLOW_TEST_API_KEY;
const flowId = process.env.LANGFLOW_TEST_FLOW_ID;
const enabled = Boolean(baseUrl && apiKey && flowId);

const DEFAULT_TWEAKS: Record<string, unknown> = {
  "WorkspaceContext-studio": { workspace_context: "{{system_context}}" },
  "MemberApps-studio": { member_id: "{{composio_user_id}}", toolkits: "{{composio_toolkits}}" },
};

const template = templateById("job-search")!;
const TEMPLATE_TASK_IDS = new Set(template.tasks.map((t) => t.id));

const RESUME_NAME = "resume.txt";
const RESUME = `Sam Example
sam@example.test · Remote, US

Senior Product Designer, Brightlane Analytics (B2B SaaS), 2021–present
- Led design for the dashboard builder used by 40 enterprise customers; cut time-to-first-chart from 20 minutes to 4.
- Built and ran the design system (120 components) shared by 3 product teams.
- Hired and mentored 2 product designers; ran weekly design critiques.

Product Designer, Quillfield (project management SaaS), 2017–2021
- Redesigned onboarding; trial-to-paid conversion rose from 9% to 13%.
- Ran 60+ customer interviews to shape the reporting roadmap.

Skills: interaction design, design systems, user research, Figma, prototyping`;

/** Words only the résumé could have taught the agent (nothing else in its context has them). */
const FROM_RESUME = /design|brightlane|quillfield|dashboard|analytics|saas/i;

type Turn = { message: string; events: AgentEvent[]; reply: string; form: UiForm | null; proposal: AgentProposal | null; rawProposal: unknown };

function tenant(): AgentTenantContext {
  return {
    workspaceId: crypto.randomUUID(),
    workspaceName: "Job search",
    userId: crypto.randomUUID(),
    composioUserId: `eval_${crypto.randomUUID()}`,
    account: { name: "Sam", about: "" },
    composioToolkits: {},
    profile: "",
    agentInstructions: template.instructions,
    memories: [],
    task: null,
    tracker: [],
    setup: { plan: [] },
    notes: [],
    agentFiles: [],
  };
}

function replyOf(events: AgentEvent[]): string {
  const messages = events.filter((e): e is Extract<AgentEvent, { type: "message" }> => e.type === "message");
  if (messages.length) return messages[messages.length - 1].text;
  return events
    .filter((e): e is Extract<AgentEvent, { type: "text-delta" }> => e.type === "text-delta")
    .map((e) => e.text)
    .join("");
}

function records(events: AgentEvent[], collection: string): Record<string, unknown>[] {
  return events
    .filter((e): e is Extract<AgentEvent, { type: "record" }> => e.type === "record")
    .map((e) => e.record as Record<string, unknown>)
    .filter((r) => r && typeof r === "object" && String(r.collection).toLowerCase() === collection);
}

const resumeFile = (): AgentAttachment => ({
  id: crypto.randomUUID(),
  name: RESUME_NAME,
  mimeType: "text/plain",
  size: RESUME.length,
  read: async () => new Blob([RESUME], { type: "text/plain" }),
});

/** The member's answers to a form: prefills as drafted, a plain answer where one's required. */
function fill(form: UiForm): { values: FormValues; attachResume: boolean } {
  const values: FormValues = {};
  let attachResume = false;
  for (const f of form.fields) {
    switch (f.kind) {
      case "choice":
        values[f.id] = f.prefill?.length ? f.prefill : [f.options[0].label];
        break;
      case "multi_choice":
        values[f.id] = f.prefill?.length ? f.prefill : f.options.slice(0, 3).map((o) => o.label);
        break;
      case "text":
      case "long_text":
        if (f.prefill) values[f.id] = f.prefill;
        else if (/\bpay\b|salary|compensation/i.test(f.label)) values[f.id] = "$150k";
        else if (/location|where/i.test(f.label)) values[f.id] = "Remote, US";
        else if (/break/i.test(f.label)) values[f.id] = "Crypto, agencies";
        else if (f.required) values[f.id] = "Nothing more to add.";
        break;
      case "file":
        values[f.id] = [RESUME_NAME];
        attachResume = true;
        break;
      case "list":
        if (f.prefill?.length) values[f.id] = f.prefill;
        break;
      case "connect":
        // Connecting is done in the card itself, not in the answer; the member skips it here.
        break;
    }
  }
  return { values, attachResume };
}

describe.skipIf(!enabled)("Job search setup interview against a live flow", () => {
  const t = tenant();
  const conversationId = crypto.randomUUID();
  const turns: Turn[] = [];
  let config: LangflowConfig;

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
  async function send(message: string, withResume = false): Promise<Turn> {
    config ??= { baseUrl: baseUrl!, apiKey: apiKey!, flowId: flowId!, stream: true, tweaks: await tweaks() };
    if (withResume && !t.agentFiles!.includes(RESUME_NAME)) t.agentFiles!.push(RESUME_NAME);
    const events: AgentEvent[] = [];
    for await (const e of createLangflowAdapter(config).run({
      conversationId,
      threadId: null,
      message,
      history: [],
      tenant: t,
      // Agent files ride along with every run once added (src/lib/chat/run.ts).
      attachments: t.agentFiles!.includes(RESUME_NAME) ? [resumeFile()] : [],
      signal: AbortSignal.timeout(280_000),
    })) {
      events.push(e);
    }
    for (const e of events) {
      if (e.type === "plan-update") {
        const plan = planFromAgent(e.plan);
        if (plan) t.setup = { plan: plan.map((s) => ({ text: s.text, status: s.status })) };
      } else if (e.type === "memory-proposal") {
        t.memories.push(e.content);
      }
    }
    for (const r of records(events, "stories")) {
      const key = String(r.key ?? "");
      const title = String(r.title ?? key);
      t.tracker = [...t.tracker!.filter((x) => x.key !== key), { collection: "stories", key, title, status: null }];
      t.notes = [...t.notes!.filter((n) => n.title !== title), { collection: "stories", title, fields: (r.fields as Record<string, unknown>) ?? {} }];
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
    const turn = { message, events, reply: replyOf(events), form, proposal, rawProposal };
    turns.push(turn);
    return turn;
  }

  /** Answers what the last turn asked (a form, or ask_user's questions), as the member would. */
  async function answer(last: Turn, opts: { resume?: boolean } = {}): Promise<Turn> {
    if (last.form) {
      const { values, attachResume } = fill(last.form);
      return send(formAnswerText(last.form, values), attachResume || opts.resume);
    }
    const asked = last.events.find((e) => e.type === "questions");
    const questions = asked?.type === "questions" ? buildQuestions(asked.questions) : null;
    const text = questions ? questions.map((q) => `${q.question} ${q.options[0].label}`).join("\n") : "Sounds good, go on.";
    return send(text, opts.resume);
  }

  // SETUP_EVAL_LOG=<path> writes the transcript there, for seeing what the model did.
  afterAll(() => {
    const log = process.env.SETUP_EVAL_LOG;
    if (log) writeFileSync(log, JSON.stringify(turns.map(({ events, ...rest }) => ({ ...rest, events: events.filter((e) => e.type !== "text-delta") })), null, 2));
  });

  const describeTurn = (turn: Turn) => `reply: ${turn.reply.slice(0, 600)}\nevents: ${turn.events.map((e) => e.type).join(", ")}`;

  it("opens with a greeting and a form, not a wall of prose", { timeout: 300_000 }, async () => {
    const first = await send(renderSkillMessage(setupSkill("job-search"), ""));
    expect(first.form, describeTurn(first)).not.toBeNull();
    expect(first.reply.trimStart(), describeTurn(first)).toMatch(/^Hey!/);
    expect(first.reply.length, describeTurn(first)).toBeLessThan(700);
  });

  it("reads the résumé and prefills the next form from it", { timeout: 900_000 }, async () => {
    // Answer step by step until the résumé has gone in (the form asking for it, or alongside
    // the first answer if the agent never asks), then look at the form that follows.
    let last = turns[turns.length - 1];
    expect(last?.form, "needs the opening form").toBeTruthy();
    for (let i = 0; i < 3 && !t.agentFiles!.includes(RESUME_NAME); i++) {
      const asksForFile = last.form?.fields.some((f) => f.kind === "file") ?? false;
      last = await answer(last, { resume: i === 1 && !asksForFile });
    }
    expect(t.agentFiles, "the résumé never went in").toContain(RESUME_NAME);
    expect(last.form, describeTurn(last)).not.toBeNull();
    const prefills = last.form!.fields.flatMap((f) =>
      "prefill" in f && f.prefill ? (Array.isArray(f.prefill) ? f.prefill.map((p) => (typeof p === "string" ? p : Object.values(p).join(" "))) : [f.prefill]) : [],
    );
    expect(prefills.join(" | "), `form "${last.form!.title}" isn't prefilled from the résumé`).toMatch(FROM_RESUME);
  });

  it("saves the stories the member sends to the stories tracker", { timeout: 900_000 }, async () => {
    let last = turns[turns.length - 1];
    let saved: Record<string, unknown>[] = [];
    for (let i = 0; i < 4 && saved.length === 0 && !last.proposal; i++) {
      last = await answer(last);
      saved = records(last.events, "stories");
    }
    expect(saved.length, describeTurn(last)).toBeGreaterThan(0);
    for (const r of saved) {
      expect(String(r.key ?? ""), JSON.stringify(r)).not.toBe("");
      const fields = (r.fields ?? {}) as Record<string, unknown>;
      expect(Object.keys(fields), JSON.stringify(r)).toEqual(expect.arrayContaining(["situation", "action", "result"]));
    }
  });

  it("ends with a proposal that switches on the template's tasks with valid schedules", { timeout: 900_000 }, async () => {
    let last = turns[turns.length - 1];
    for (let i = 0; i < 4 && !last.proposal; i++) last = await answer(last);
    expect(last.proposal, describeTurn(last)).not.toBeNull();
    // What the app reads from it (the validated card), and what the agent sent.
    const tasks = last.proposal!.tasks;
    const raw = last.rawProposal as { tasks?: Record<string, unknown>[] };
    const templated = tasks.filter((x) => x.templateTaskId);
    expect(templated.length, JSON.stringify(raw.tasks)).toBeGreaterThan(0);
    tasks.forEach((task, i) => {
      const sent = Array.isArray(raw.tasks) ? raw.tasks[i]?.schedule : undefined;
      expect(sent == null || task.schedule !== null, `couldn't read "${task.title}" schedule ${JSON.stringify(sent)}`).toBe(true);
    });
    for (const task of templated) {
      const id = task.templateTaskId!;
      expect(TEMPLATE_TASK_IDS.has(id), `unknown template task "${id}"`).toBe(true);
      const onDemand = template.tasks.find((x) => x.id === id)!.schedule === null;
      if (task.schedule === null) expect(onDemand, `"${id}" was proposed without a schedule`).toBe(true);
      else expect(taskScheduleSchema.safeParse(task.schedule).success, `"${id}" schedule ${JSON.stringify(task.schedule)}`).toBe(true);
    }
    expect(templated.some((x) => x.schedule !== null), "no proposed task runs on a schedule").toBe(true);
    // Nothing is applied yet, so the agent mustn't say it is.
    expect(last.reply).not.toMatch(/\b(you're|you are|you're all|we're|i'm|i am) (all )?set up\b/i);
  });

  it("changes nothing outside the member's own notes before Apply", () => {
    expect(turns.length).toBeGreaterThan(1);
    const events = turns.flatMap((x) => x.events);
    expect(events.filter((e) => e.type === "approval")).toEqual([]);
    const wrote = events.filter(
      (e) => e.type === "activity" && e.action === "write" && e.status === "done" && !["tracker", "memory"].includes(e.app ?? ""),
    );
    expect(wrote).toEqual([]);
  });
});

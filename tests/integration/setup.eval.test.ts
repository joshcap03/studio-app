import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { createLangflowAdapter, type LangflowConfig } from "@/lib/agent/langflow";
import type { AgentAttachment, AgentEvent, AgentTenantContext } from "@/lib/agent/types";
import { buildQuestions } from "@/lib/chat/questions";
import { buildUiBlock, scheduleFrom } from "@/lib/chat/ui";
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
    // The first run has no setup yet: the app marks it under way after that run starts. From
    // then on the setup instructions ride along (see send()).
    setup: null,
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

/**
 * The member's bar, as crisp answers of their own where a card lets them say "something else".
 * Words from it showing up in the proposal's instructions mean the agent carried the bar through.
 */
const BAR: [RegExp, string][] = [
  [/one thing|most want/i, "Find senior product design roles that actually fit me, so I only spend time applying to good ones."],
  [/great|judge|good/i, "Remote in the US, $180k base or more, posted in the last 3 days"],
  [/stop using|deal|hate/i, "Agency roles instead of in-house"],
];
/** How the member answers discovery's open questions, in order, as a real person would. */
const DISCOVERY = [
  "I'm a senior product designer and I want to move to a new role this year.",
  "Honestly I waste hours on postings that turn out to be junior, agency, or on-site. I only want to spend time on roles that genuinely fit.",
  "LinkedIn alerts. They're noisy and I stopped reading them.",
  "I'd apply to a few great roles a week instead of skimming hundreds, and be sharp when interviews come.",
  "Don't apply or email anyone without me.",
];
let discovered = 0;
/** The agent giving its own read and recommendation, as discovery ends. */
const ADVICE = /\b(recommend|suggest|i'd start|help (you )?most|where i (can|could) help|here's my read)\b/i;
/** The member's reply to a plain question: the next part of their story, or a yes to a playback. */
function talk(reply: string): string {
  // The agent's advice: agree with the lead idea, with a nuance of their own.
  if (discovered >= 2 && ADVICE.test(reply))
    return "Yes, start with finding roles that really fit. Interview prep matters too, but later.";
  if (discovered >= 2 && /\b(right|correct|accurate|sound right|fair|is that it|get that right)\?/i.test(reply)) return "Yes, that's exactly it.";
  return DISCOVERY[discovered++] ?? "Yes, that's right. Go on.";
}

/** Why the member passes on trial results: a reason distinctive enough to find in their bar. */
const PASS_REASON = "Agency, not in-house";
const FROM_PASS = /agenc/i;
const FROM_BAR = /180|9 ?am|3 (of|out of) (every )?5|3 days/i;

/** The member's answers to a form: prefills as drafted, a plain answer where one's required. */
function fill(form: UiForm): { values: FormValues; attachResume: boolean } {
  const values: FormValues = {};
  let attachResume = false;
  for (const f of form.fields) {
    switch (f.kind) {
      case "choice": {
        const own = f.allowOther ? BAR.find(([q]) => q.test(f.label))?.[1] : undefined;
        values[f.id] = own ? [own] : f.prefill?.length ? f.prefill : [f.options[0].label];
        break;
      }
      case "multi_choice": {
        const own = f.allowOther ? BAR.find(([q]) => q.test(f.label))?.[1] : undefined;
        const picked = f.prefill?.length ? f.prefill : f.options.slice(0, own ? 2 : 3).map((o) => o.label);
        values[f.id] = own ? [...picked, own] : picked;
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
        values[f.id] = f.items.map((item, i): Record<string, string> => (i < 2 ? { id: item.id, verdict: "keep" } : { id: item.id, verdict: "pass", reason: PASS_REASON }));
        break;
      case "text":
      case "long_text":
        if (f.prefill) values[f.id] = f.prefill;
        else if (BAR.some(([q]) => q.test(f.label))) values[f.id] = BAR.find(([q]) => q.test(f.label))![1];
        else if (/\bpay\b|salary|compensation/i.test(f.label)) values[f.id] = "$150k";
        else if (/location|where|\bcit(y|ies)\b/i.test(f.label)) values[f.id] = "Remote, US";
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
        if (plan) t.setup = { ...t.setup, plan: plan.map((s) => ({ text: s.text, status: s.status, note: s.note })) };
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
    // As the app does once setup is under way (src/lib/workspace.ts): the setup skill stays in
    // view on every later run in this conversation.
    if (!t.setup?.instructions) t.setup = { plan: t.setup?.plan ?? [], instructions: setupSkill("job-search").instructions };
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
    const text = questions ? questions.map((q) => `${q.question} ${q.options[0].label}`).join("\n") : talk(last.reply);
    return send(text, opts.resume);
  }

  // SETUP_EVAL_LOG=<path> writes the transcript there, for seeing what the model did.
  afterAll(() => {
    const log = process.env.SETUP_EVAL_LOG;
    if (log) writeFileSync(log, JSON.stringify(turns.map(({ events, ...rest }) => ({ ...rest, events: events.filter((e) => e.type !== "text-delta") })), null, 2));
  });

  const describeTurn = (turn: Turn) => `reply: ${turn.reply.slice(0, 600)}\nevents: ${turn.events.map((e) => e.type).join(", ")}`;

  it("opens with a greeting and an open question, not a form", { timeout: 300_000 }, async () => {
    const first = await send(renderSkillMessage(setupSkill("job-search"), ""));
    expect(first.form, describeTurn(first)).toBeNull();
    expect(first.reply, describeTurn(first)).toContain("?");
    expect(first.reply.trimStart(), describeTurn(first)).toMatch(/^Hey!/);
    expect(first.reply.length, describeTurn(first)).toBeLessThan(700);
  });

  it("talks through what they're after before showing any form", { timeout: 900_000 }, async () => {
    let last = turns[turns.length - 1];
    for (let i = 0; i < 7 && !last.form; i++) last = await answer(last);
    const firstForm = turns.findIndex((x) => x.form);
    expect(firstForm, turns.map(describeTurn).join("\n---\n")).toBeGreaterThanOrEqual(2);
    const talked = turns.slice(0, firstForm);
    // Discovery is questions in plain words, not menus of what the agent can do (one quick
    // choice between alternatives their own words raised is fine).
    for (const x of talked) expect(x.reply, describeTurn(x)).toContain("?");
    expect(talked.filter((x) => x.events.some((e) => e.type === "questions")).length, "discovery asked through menus").toBeLessThanOrEqual(1);
    // And it ends with the agent's own advice before any form.
    expect(talked.some((x) => ADVICE.test(x.reply)), "no advice before the first form").toBe(true);
  });

  it("runs a real trial that fits the résumé, for the member to judge", { timeout: 900_000 }, async () => {
    // Answer until the résumé has gone in, then until the trial run shows its results.
    let last = turns[turns.length - 1];
    for (let i = 0; i < 5 && !t.agentFiles!.includes(RESUME_NAME); i++) last = await answer(last);
    // The agent itself asked for the résumé (nothing here attaches it unasked).
    expect(t.agentFiles, "the agent never asked for the résumé").toContain(RESUME_NAME);
    // A search can honestly turn up only two strong matches.
    const isTrial = (x: Turn) => x.form?.fields.some((f) => f.kind === "verdict" && f.items.length >= 2) ?? false;
    for (let i = 0; i < 4 && !isTrial(last); i++) last = await answer(last);
    expect(isTrial(last), describeTurn(last)).toBe(true);
    const results = last.form!.fields.flatMap((f) => (f.kind === "verdict" ? f.items.map((item) => `${item.title} ${item.body ?? ""}`) : []));
    expect(results.join(" | "), "the trial run doesn't fit the résumé").toMatch(FROM_RESUME);
  });

  it("turns the member's verdicts into a bar they put in order, before the search details", { timeout: 900_000 }, async () => {
    let last = turns[turns.length - 1];
    // The bar comes back for them to confirm, after the trial: as a ranked card, or laid out in
    // the reply under a "bar" heading with its criteria listed.
    const listed = (reply: string) => /\byour (fit )?bar\b/i.test(reply) && (reply.match(/^\s*(?:[-*•]|\d+[.)])\s+/gm) ?? []).length >= 3;
    const ranked = (x: Turn) =>
      !x.form?.fields.some((f) => f.kind === "verdict") && ((x.form?.fields.some((f) => f.kind === "rank") ?? false) || listed(x.reply));
    for (let i = 0; i < 3 && !ranked(last); i++) last = await answer(last);
    expect(ranked(last), describeTurn(last)).toBe(true);
    const trial = turns.findIndex((x) => x.form?.fields.some((f) => f.kind === "verdict"));
    const search = turns.findIndex((x) => /search/i.test(x.form?.title ?? ""));
    expect(trial).toBeLessThan(turns.indexOf(last));
    expect(search === -1 || search > turns.indexOf(last), "asked for search details before the bar").toBe(true);
  });

  it("saves the stories the member sends to the stories tracker", { timeout: 900_000 }, async (ctx) => {
    let last = turns[turns.length - 1];
    let saved: Record<string, unknown>[] = [];
    for (let i = 0; i < 5 && saved.length === 0 && !last.proposal; i++) {
      last = await answer(last);
      saved = records(last.events, "stories");
    }
    // The member put interview prep off for later, so the agent may rightly skip stories: then
    // nothing is saved to stories, and this check is skipped rather than passed.
    if (!turns.some((x) => x.form?.fields.some((f) => f.kind === "list"))) {
      expect(turns.flatMap((x) => records(x.events, "stories"))).toEqual([]);
      ctx.skip();
    }
    expect(saved.length, describeTurn(last)).toBeGreaterThan(0);
    for (const r of saved) {
      expect(String(r.key ?? ""), JSON.stringify(r)).not.toBe("");
      const fields = (r.fields ?? {}) as Record<string, unknown>;
      // Gaps stay empty rather than invented, so a story needs only some of its parts.
      expect(Object.keys(fields).filter((k) => ["situation", "task", "action", "result"].includes(k)).length, JSON.stringify(r)).toBeGreaterThanOrEqual(2);
    }
  });

  it("ends with a proposal that switches on the template's tasks with valid schedules", { timeout: 900_000 }, async () => {
    let last = turns[turns.length - 1];
    for (let i = 0; i < 6 && !last.proposal; i++) last = await answer(last);
    expect(last.proposal, describeTurn(last)).not.toBeNull();
    // What the app reads from it (the validated card), and what the agent sent.
    const tasks = last.proposal!.tasks;
    const raw = last.rawProposal as { tasks?: Record<string, unknown>[] };
    const templated = tasks.filter((x) => x.templateTaskId);
    expect(templated.length, JSON.stringify(raw.tasks)).toBeGreaterThan(0);
    tasks.forEach((task, i) => {
      const sent = Array.isArray(raw.tasks) ? raw.tasks[i]?.schedule : undefined;
      expect(sent == null || scheduleFrom(sent) === null || task.schedule !== null, `couldn't read "${task.title}" schedule ${JSON.stringify(sent)}`).toBe(true);
    });
    for (const task of templated) {
      const id = task.templateTaskId!;
      expect(TEMPLATE_TASK_IDS.has(id), `unknown template task "${id}"`).toBe(true);
      const onDemand = template.tasks.find((x) => x.id === id)!.schedule === null;
      if (task.schedule === null) expect(onDemand, `"${id}" was proposed without a schedule`).toBe(true);
      else expect(taskScheduleSchema.safeParse(task.schedule).success, `"${id}" schedule ${JSON.stringify(task.schedule)}`).toBe(true);
    }
    expect(templated.some((x) => x.schedule !== null), "no proposed task runs on a schedule").toBe(true);
    // It's built on, and holds later runs to, the bar the member confirmed.
    const instructions = last.proposal!.instructions ?? "";
    expect(instructions, "the proposal doesn't say what success means").toMatch(/what success means/i);
    expect(instructions, "the proposal dropped the member's bar").toMatch(FROM_BAR);
    expect(instructions, "the bar didn't learn from what they passed on in the trial run").toMatch(FROM_PASS);
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

  it("shows every card the agent sent whole: no field, prefill, task, or schedule dropped", () => {
    const lost: string[] = [];
    for (const e of turns.flatMap((x) => x.events)) {
      if (e.type !== "ui") continue;
      const raw = e.block as { form?: { title?: string; fields?: Record<string, unknown>[] }; proposal?: { tasks?: Record<string, unknown>[] } };
      const block = buildUiBlock(e.block);
      if (raw.form) {
        const fields = block?.kind === "form" ? block.fields : [];
        const intro = block?.kind === "form" ? (block.intro ?? "") : "";
        const judged = fields.flatMap((x) => (x.kind === "verdict" ? x.items.map((item) => item.title) : []));
        (raw.form.fields ?? []).forEach((f, i) => {
          const kind = String(f.kind ?? f.type ?? "").toLowerCase();
          // Read-only notes join the intro; one-result verdict fields become items of one field.
          if (kind === "note" && intro.includes(String(f.value ?? f.text ?? f.label ?? "").trim().slice(0, 40))) return;
          if (kind === "verdict" && judged.includes(String(f.label ?? "").trim())) return;
          // A scale's ends written into its label are shown under it, so its label is shorter.
          const asked = String(f.label ?? "").trim();
          const kept = fields.find((x) => x.label === asked || (x.kind === "scale" && asked.startsWith(x.label)));
          if (!kept) lost.push(`form "${raw.form!.title}" field ${i}: ${JSON.stringify(f).slice(0, 200)}`);
          // A verdict's and a rank's `items` are what it shows, not a prefill.
          else if (kind !== "verdict" && kind !== "rank" && ![null, undefined, ""].includes((f.prefill ?? f.value ?? f.items) as string) && !("prefill" in kept && kept.prefill))
            lost.push(`form "${raw.form!.title}" prefill of "${kept.label}": ${JSON.stringify(f).slice(0, 200)}`);
        });
      } else if (raw.proposal) {
        const tasks = block?.kind === "proposal" ? block.tasks : [];
        (raw.proposal.tasks ?? []).forEach((t, i) => {
          if (!tasks[i]) lost.push(`proposed task ${i}: ${JSON.stringify(t).slice(0, 200)}`);
          else if (t.schedule != null && scheduleFrom(t.schedule) !== null && tasks[i].schedule === null) lost.push(`schedule of "${tasks[i].title}": ${JSON.stringify(t.schedule)}`);
        });
      }
    }
    expect(lost).toEqual([]);
  });
});

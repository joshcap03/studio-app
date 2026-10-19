import { afterAll, describe, expect, it } from "vitest";
import { buildUiBlock, scheduleFrom } from "@/lib/chat/ui";
import { taskScheduleSchema } from "@/lib/tasks/schedule";
import { templateById } from "@/lib/templates";
import { carriesRankedBar, checklistGrowth, describeTurn, liveFlow, records, setupSession, type ScriptedMember, type Turn } from "./setup-harness";

// Eval of the Job search setup interview against a live flow with a real model (LANGFLOW_TEST_*
// env; see setup-harness.ts). A scripted job seeker answers whatever the agent shows. The checks
// look at the cards and structured events, not at the model's wording (apart from the greeting).
// The résumé is a made-up fixture.

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

/** The agent giving its own read and recommendation, as discovery ends. */
const ADVICE = /\b(recommend|suggest|i'd start|help (you )?most|where i (can|could) help|here's my read|i think i (can|could)|i'd leave)\b/i;

const SEEKER: ScriptedMember = {
  templateId: "job-search",
  agentName: "Job search",
  name: "Sam",
  discovery: [
    "I'm a senior product designer and I want to move to a new role this year.",
    "Honestly I waste hours on postings that turn out to be junior, agency, or on-site. I only want to spend time on roles that genuinely fit.",
    "LinkedIn alerts. They're noisy and I stopped reading them.",
    "I'd apply to a few great roles a week instead of skimming hundreds, and be sharp when interviews come.",
    "Don't apply or email anyone without me.",
  ],
  advice: ADVICE,
  // Agrees with the lead idea, with a nuance of their own.
  agree: "Yes, start with finding roles that really fit. Interview prep matters too, but later.",
  // Words from it showing up in the proposal's instructions mean the agent carried the bar through.
  bar: [
    [/one thing|most want/i, "Find senior product design roles that actually fit me, so I only spend time applying to good ones."],
    [/great|judge|good/i, "Remote in the US, $180k base or more, posted in the last 3 days"],
    [/stop using|deal|hate/i, "Agency roles instead of in-house"],
  ],
  passReason: "Agency, not in-house",
  text: (label) =>
    /\bpay\b|salary|compensation/i.test(label)
      ? "$150k"
      : /location|where|\bcit(y|ies)\b/i.test(label)
        ? "Remote, US"
        : /break/i.test(label)
          ? "Crypto, agencies"
          : undefined,
  file: { name: RESUME_NAME, mimeType: "text/plain", content: RESUME },
};

const FROM_PASS = /agenc/i;
// The agent designs the success form itself, so the bar may come from any of their answers.
const FROM_BAR = /180|150|2[-–]3|9 ?am|3 (of|out of) (every )?5|3 days/i;

describe.skipIf(!liveFlow)("Job search setup interview against a live flow", () => {
  const session = setupSession(SEEKER);
  const { turns, answer } = session;
  const t = session.tenant;

  afterAll(() => session.writeLog("job search setup"));

  it("opens with a greeting and an open question, not a form", { timeout: 300_000 }, async () => {
    const first = await session.start();
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
    expect(talked.slice(1).some((x) => ADVICE.test(x.reply)), "no advice before the first form").toBe(true);
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
    expect(FROM_BAR.test(instructions) || carriesRankedBar(turns, instructions), `the proposal dropped the member's bar: ${instructions.slice(0, 400)}`).toBe(true);
    expect(instructions, "the bar didn't learn from what they passed on in the trial run").toMatch(FROM_PASS);
    // Nothing is applied yet, so the agent mustn't say it is.
    expect(last.reply).not.toMatch(/\b(you're|you are|you're all|we're|i'm|i am) (all )?set up\b/i);
  });

  it("lists only what it knows: two steps to start, and nothing past the bar until it's confirmed", () => {
    const growth = checklistGrowth(turns);
    expect(growth.first, "no checklist on the first reply").not.toBeNull();
    expect(growth.first!, "the first checklist laid out the whole setup").toBeLessThanOrEqual(2);
    expect(growth.early, "the checklist listed later setup before the bar was confirmed").toEqual([]);
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
          // (A result written whole into its label keeps its title as the item and its detail as the body.)
          if (kind === "verdict" && judged.some((title) => String(f.label ?? "").includes(title))) return;
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

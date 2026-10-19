import type { AppId } from "@/lib/apps";
import type { TaskSchedule } from "@/lib/tasks/schedule";

// Built-in starting points for a workspace: what the agent is for, how it should work, and
// which library skills and apps fit. Applying one copies these into the workspace (see
// apply.ts), where the owner edits them freely; the agent only ever sees the workspace's
// copy. Templates are generic and public: no tenant, person, or company belongs here.

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  /** Placeholder for the "What this agent is for" field: what to tell the agent. */
  profilePrompt: string;
  /** Starting instructions for the agent. Only filled in when the workspace has none. */
  instructions: string;
  /** Library skills (src/lib/skills/catalog.ts) copied into the workspace. */
  skills: string[];
  /** Apps worth connecting, suggested, never connected automatically. */
  apps: AppId[];
  /** Apps that help but aren't needed, suggested as optional. */
  optionalApps?: AppId[];
  /**
   * Tasks the member applying the template gets as their own, paused until they turn each
   * on. `id` keeps applying idempotent; `skill` is a library skill from `skills`.
   */
  tasks: TemplateTask[];
  /**
   * The setup interview a new agent opens with (src/lib/skills/setup.ts runs it). Every
   * template has one: it's how the agent learns what the member needs before it starts.
   */
  setup: TemplateSetup;
  /**
   * Tracker collections the agent should see in full (fields included) in every chat, not
   * just in tasks, e.g. interview stories. Kept small: a few rows of reference material.
   */
  contextCollections?: string[];
}

export interface TemplateSetup {
  /** One sentence on what setting up gets the member, as the agent would say it. */
  intro: string;
  /**
   * A vague and a crisp way to say what success is for this kind of agent, for the agent to
   * coach with in the success step (SUCCESS_STEP). It's an illustration, never the member's bar.
   */
  successExample: { vague: string; crisp: string };
  /**
   * What this kind of agent usually helps with, for the agent's own bearings in discovery. Never
   * shown as a menu: the member says what they're after in their own words.
   */
  usualHelp: string;
  /**
   * What doing this job well takes, as a seasoned expert would know it, for the agent's own
   * bearings when it drafts its plan (PLAN_STEP). Never shown as a checklist: their plan is built
   * on their bar and their advice.
   */
  craft: string;
  /**
   * Context the success step needs, after discovery, e.g. a résumé, so a trial run is a fair
   * test. Gathering only: nothing here plans or designs anything.
   */
  before?: TemplateSetupStep[];
  /**
   * After SUCCESS_STEP and PLAN_STEP: what else the agent may need to carry out the plan. A guide,
   * not a script: the agent skips or merges what the plan doesn't need. The last one proposes the
   * setup.
   */
  steps: TemplateSetupStep[];
}

export interface TemplateSetupStep {
  id: string;
  /** A short checklist label, e.g. "Your résumé". */
  title: string;
  /** What to learn in this step, written for the agent, which designs any form for it. */
  goal: string;
}

/**
 * The step every setup opens with: a conversation, not a form. Like a product manager meeting a
 * new customer, the agent works out what the member is really trying to get done, and why,
 * before it assumes anything about how it could help. Nothing is planned or asked in a form
 * until the member agrees with how it's stated their problem.
 */
export const DISCOVERY_STEP: TemplateSetupStep = {
  id: "discovery",
  title: "What you're after",
  goal: `Work out, with them, where they genuinely need help, the way a careful product thinker or a good advisor would. Many people aren't sure yet how they want help, so start from their challenges, not from what you can do. This is a conversation in plain words: open questions in your reply text, one per reply, no forms. Usually 3-5 short exchanges, then your advice.
  - Open with their situation and what's been hardest about it lately. Don't ask "what do you want me to do?", don't offer options, and don't assume this agent's usual help is what they need (it usually helps with: {usual}; that's background for you, not a menu).
  - Dig into the one or two challenges that matter most, choosing each next question from what they just said: what makes it hard, why it matters now, what they've tried and what fell short, and what would be different if it got better. When they jump to a solution ("find me jobs"), ask about the need behind it.
  - Reflect back briefly in their words before each next question, so they can correct you. Question assumptions, including your own.
  - Then advise. Give your honest read in a few sentences: the problem as you understand it, the 2-3 ways you think you could help most (your recommendation first, and why; if their personal rules rule out recommending or deciding for them, lay the ways out side by side with their tradeoffs and don't pick one), what you'd leave alone or couldn't do well, and any tradeoff they should weigh. Ask what feels right, what's missing, or what they'd change. Their answer is free text; don't turn your advice into a multiple choice.
  - Go back and forth until they agree with how you've put their problem and where you'll help. Then remember it in one line, and the step is done.`,
};

/**
 * Before anything is planned, the member says, as crisply as a product manager writing
 * acceptance criteria, how they'll judge the help they asked for in discovery. The agent designs
 * the form for their problem (nothing here prescribes its fields), and the proposal at the end
 * is built on, and held to, what they confirm.
 */
export const SUCCESS_STEP: TemplateSetupStep = {
  id: "success",
  title: "What success looks like",
  goal: `Turn the problem they agreed on into a bar this agent can be held to, before anything is planned. Design this step yourself around their problem; don't use a stock set of questions.
  a. Generate one show_form built for what they told you and the help you agreed on, asking only what you still need to judge success: what a great result is for them, when and how often it should come, how strict to be, and what would make them stop using you. Offer choices only where there are real, distinct alternatives you can draft from their own words (they can always add their own); where the answer is personal or you can't foresee it, ask it open. Use a scale where it's a matter of degree. A few fields, not a survey; prefill only what they've said.
  b. Before drafting the bar, do a trial run: the job once, for real, with your tools (read and search only; change nothing; save nothing), and show the 2-5 best results in a show_form titled "Trial run" with ONE verdict field (the results as its items; the card adds Keep and Pass), with reasons to pass drawn from their answers. Their keeps and passes are the best evidence of what "good" means to them. If the job is about their own records or accounts (their inbox, invoices, orders) and that app isn't connected, first offer once to connect it with a connect field, saying the trial will use their real data once it is. If they don't connect it, run the trial on what they can give you (a few rows they paste, say) or what you can reach, say once what that leaves out, and carry on; the proposal names the missing connection as a gap. Skip it only if you have no tool that can do any part of the job, and then say so. Never pass off made-up results as real.
  c. Draft 3-6 criteria in their words, each one a result can pass or fail (a number, a deadline, a yes/no), sharpened by what they passed on and why. show_form titled "Your bar" with a rank field (each criterion at most 80 characters, how you'll check it as its description) and an optional "Anything to change or add?". Ask about anything still vague with a choice of 2-4 concrete readings. If a criterion can't realistically be met, or two pull against each other, say so once in your reply with your reason and a concrete alternative, then take their call. When they send it back, that's the bar: remember it in one line.
For your own bearings (an illustration only; their bar is their own): vague "{vague}"; crisp "{crisp}".`,
};

/**
 * Once their bar is set, the agent works out with the member how to do the job well, as
 * carefully as they agreed the bar: the bar says what a great result is, this says how to get
 * there. Like a seasoned expert, it brings a point of view, writes out its plan, and takes the
 * member's advice on it. The proposal is built on the plan they confirm.
 */
export const PLAN_STEP: TemplateSetupStep = {
  id: "plan",
  title: "How to do it well",
  goal: `Work out with them how to do the job well, as carefully as you agreed their bar: the bar says what a great result is, this says how you'll get there. Bring an expert's point of view, and get what they know that you don't. This is a conversation, usually 3-5 short exchanges; use a small show_form only to collect specifics the plan needs (a list of names, say).
  a. If discovery and the trial haven't already told you how they've gone about it so far, and what has and hasn't worked, ask that first.
  b. Then write out your plan in your reply, in 3-6 numbered steps, each saying what you'll do and why in plain words: where you'll look or what you'll work from, how you'll pick out the best against their bar, what you'll bring them and how often, how hands-on you'll be, and what you'll leave to them. Build it on their bar, their trial verdicts, what they've told you, and what you know about doing this well ({craft}). Where an expert would go about it differently from how they have been, say so and why. Name any part you can't do yet (a missing app or access) and what it would take, and what else you'll need from them to carry it out (details, a file, an app): the steps after this gather only that.
  c. Talk it through, one question per reply, on the parts where what they know or think should decide: sources, places, or people you'd miss; the tradeoffs in the plan (wide or narrow, fast or thorough, how often); and what would make them stop trusting how you did it. Take their advice in and say what changed. If a suggestion would cost them against their bar, say so once with your reason and an alternative, then take their call. If their personal rules rule out recommending, lay the approaches out side by side with their tradeoffs and let them choose.
  d. When they're happy with it, play the whole plan back in its final steps and ask them to confirm it. Their yes to the whole plan makes it the plan (a go-ahead on one part of it isn't that): remember it in one line. Don't move on until then.`,
};

/** The setup steps an agent made from `template` runs, in order. */
export function setupSteps(template: AgentTemplate): TemplateSetupStep[] {
  const { usualHelp, successExample, craft } = template.setup;
  const discovery = { ...DISCOVERY_STEP, goal: DISCOVERY_STEP.goal.replace("{usual}", usualHelp) };
  const success = { ...SUCCESS_STEP, goal: SUCCESS_STEP.goal.replace("{vague}", successExample.vague).replace("{crisp}", successExample.crisp) };
  const plan = { ...PLAN_STEP, goal: PLAN_STEP.goal.replace("{craft}", craft) };
  return [discovery, ...(template.setup.before ?? []), success, plan, ...template.setup.steps];
}

export interface TemplateTask {
  id: string;
  title: string;
  instructions: string;
  skill?: string;
  schedule: TaskSchedule | null;
}

export const TEMPLATES: AgentTemplate[] = [
  {
    id: "job-search",
    name: "Job search",
    description: "Finds roles that fit, tailors applications, drafts outreach, and preps you for interviews.",
    profilePrompt:
      "The roles you're after (titles, seniority), where (cities, remote), your pay floor, must-haves and deal-breakers, and a few lines on your background. Add your résumé to this agent's files (on its page) so it reads it in every chat.",
    instructions: `You run my job search with me, end to end.
- Keep a job tracker with one entry per role: company, title, link, score, status, next step. Statuses: discovered, shortlisted, applied, outreach, interviewing, offer, closed.
- If this workspace has a tracker in Studio, use it: save_record with collection "applications" and key = the posting's link (people I contact go in "contacts", key = their email or profile link). Saving the same key again updates that row, so check what's already tracked and never add a role twice. Otherwise keep a Google Sheet called "Job search tracker" with the same columns.
- When working on a task, keep its plan current with update_plan.
- To find people, use Apollo or Clay if connected, otherwise public web sources. Verify an email with Hunter or a source before using it; never guess one. Unify isn't available; offer these instead if I ask for it.
- Only ever use facts about me from my profile, files, and memory. Never invent experience or numbers.
- Applications, emails, Apollo sequences, and messages are drafts until I approve each one: submitting, sending, adding someone to a sequence, or activating one always waits for my approval.
- When something is ambiguous about what I want, ask me one short question rather than guessing.`,
    skills: ["find-roles", "research-company", "tailor-application", "outreach-drafts", "interview-prep"],
    apps: ["gmail", "apollo", "hunter", "calendar", "docs", "sheets", "drive"],
    optionalApps: ["clay"],
    tasks: [
      {
        id: "find-new-roles",
        title: "Find new roles",
        skill: "find-roles",
        schedule: { every: "weekdays", at: "08:00" },
        instructions: `Find roles posted since the last run that fit my profile.
- Save each role worth tracking with save_record: collection "applications", key = the posting's link (the company's own page when there is one), title "Company — Role", status "discovered", and fields for location, pay if listed, score (1–5) and why.
- Skip any role whose link is already in the tracker, and anything that hits a deal-breaker.
- Don't apply or contact anyone. Show the new roles, best first, in a verdict card for me to keep or pass on, or say there were none.`,
      },
      {
        id: "check-replies",
        title: "Check replies and follow up",
        schedule: { every: "weekdays", at: "12:00" },
        instructions: `Check Gmail for replies to my outreach and applications since the last run.
- For each reply, update the matching "contacts" row and its "applications" row with save_record (same keys), with the new status and the next step.
- Draft follow-ups that are due today (no reply after 5 business days, or a promised follow-up). Save them as drafts; sending waits for my approval.
- Reply with who answered, what changed in the tracker, and the drafts ready for me.`,
      },
      {
        id: "weekly-pipeline-review",
        title: "Weekly pipeline review",
        schedule: { every: "week", weekday: 1, at: "09:00" },
        instructions: `Review my job search pipeline for the week.
- Summarize the "applications" tracker by status, with counts.
- Find what's stuck: applied with no reply after 10 days, outreach with no follow-up, shortlisted roles not applied to.
- Update this task's plan with update_plan: the week's priorities, one step each.
- Reply with the summary, what's stuck, and the 3 things to do first.`,
      },
      {
        id: "interview-prep",
        title: "Interview prep",
        skill: "interview-prep",
        schedule: null,
        instructions: `Prepare me for my next interview (from my calendar, or the one I name when I run this).
- Mark the role "interviewing" in the "applications" tracker with save_record if it isn't already.
- Don't contact anyone or accept invites.`,
      },
    ],
    contextCollections: ["stories"],
    setup: {
      intro: "I'll start by understanding what's been hard about your search, suggest where I can help most, agree with you how to judge it and how to do it well, and then set myself up to work that way.",
      successExample: {
        vague: "Find me good jobs.",
        crisp: "Each weekday by 9am, 3-5 new senior product design roles: remote in the US, $180k+ base, B2B SaaS, posted in the last 3 days, none I've seen before, each with one line on why it fits. If I'd pass on more than 2 of every 5, it isn't working.",
      },
      usualHelp: "finding roles that fit, tailoring applications, reaching the right people, and preparing for interviews",
      craft:
        "the best roles often never reach the big job boards, or draw hundreds of applicants within days, so a strong search usually starts from the target roles and level their bar and résumé point to, and a short list of target companies that fit (ones they'd love to work at, peers of companies they've done well at, ones growing or recently funded), checks those companies' own career pages and hiring boards (Greenhouse, Lever, Ashby) as well as the job boards, catches new postings within a few days since early applicants get read, looks for a warm way in to each top role (a former colleague, an alum, the hiring manager) before a cold application, and looks back each week at what's getting replies to shift effort there",
      // The trial run is only a fair test once the agent knows their background.
      before: [
        {
          id: "resume",
          title: "Your résumé",
          goal: `If what they're after needs their background (it usually does in a job search), get their résumé onto this agent's files. If CONTEXT already lists one, say so and skip ahead; if their problem doesn't need it, skip this and say why. Otherwise show_form with a file field (keep: true, accept pdf, docx, txt, md) and an open "Anything that isn't on it?". When it arrives, read it, and remember the few facts you'll lean on most.`,
        },
      ],
      steps: [
        {
          id: "stories",
          title: "Your stories",
          goal: `If interviews are part of what they're after, get stories ready. Draft 3-5 STAR stories from the résumé's strongest bullets (only facts that are there; leave a part empty rather than writing a placeholder), and show them in a list field (item_label "Story"; parts situation, task, action, result, skills) for them to fix and add to. Save every story they send right away, gaps and all (say which could use more detail), with save_record: collection "stories", key a short slug of its title, title a few words naming it, fields situation, task, action, result, skills. If CONTEXT has no tracker section, remember one sentence per story instead. Skip this if interviews aren't part of it yet.`,
        },
        {
          id: "apps",
          title: "Your apps",
          goal: `Connect only the apps their bar and plan need, with a connect field and a line on what each is for: gmail and calendar for replies and interviews, apollo and hunter for finding the right people, clay optionally. Say they can skip any and connect later; skip this if none are needed.`,
        },
        {
          id: "design",
          title: "How I'll work",
          goal: `Design this agent for them with propose_agent: a profile summarizing the search in their words, instructions that adapt this agent's current instructions to their bar and what they told you (focus, how proactive, how to check in), the listed tasks that serve their bar switched on (each with its template_task_id, title, instructions, and a schedule object such as {every: "weekdays", at: "08:00"} that matches how often they want check-ins), any library skills they need that the agent lacks, and a few lasting facts to remember.`,
        },
      ],
    },
  },
  {
    id: "small-business",
    name: "Small business",
    description: "Helps run a shop or service business: customers, sales, stock, money, and marketing.",
    profilePrompt: "What you sell, who buys it, how you work, and the tools you run on (e.g. Shopify, QuickBooks, Gmail).",
    instructions: `You help me run my business day to day.
- Check the connected apps for real numbers before answering questions about sales, stock, or money.
- Anything that would reach a customer, a supplier, or move money is a draft until I approve it.`,
    skills: ["business-snapshot", "inbox-triage", "customer-email-replies", "weekly-sales-report"],
    apps: ["gmail", "shopify", "sheets", "quickbooks"],
    tasks: [],
    setup: {
      intro: "I'll start by understanding what's taking up your time in the business, suggest where I can help most, agree with you how to judge it and how to do it well, and then set myself up to work that way.",
      successExample: {
        vague: "Help with customer emails.",
        crisp: "Every customer email gets a reply drafted within 2 hours on weekdays, in my tone, with the right order details from Shopify; I send at least 4 of every 5 without editing, and nothing promising a refund goes out without me.",
      },
      usualHelp: "customer emails, sales and money questions, stock, invoices, and marketing",
      craft:
        "good help in a small business works from the owner's real numbers and real customer messages rather than guesses, learns the owner's voice from what they've already sent, handles the frequent, repetitive cases first and flags the unusual ones, drafts anything that reaches a customer or moves money for the owner to approve, and reports briefly on a rhythm the owner already keeps",
      steps: [
        {
          id: "business",
          title: "Your business",
          goal: `Learn what you still need about the business to carry out the plan (what they sell and to whom, where, how they talk to customers, anything to keep on hand like a price list), and nothing more. Design the form from what discovery already told you, drafting choices from their words; a file field (keep: true) if a document would help.`,
        },
        {
          id: "apps",
          title: "Your tools",
          goal: `Connect only the apps their bar and plan need (gmail, shopify, sheets, quickbooks), with a line on what you'd use each for. Say they can skip any and connect later.`,
        },
        {
          id: "design",
          title: "How I'll work",
          goal: `Design this agent with propose_agent: a profile of the business in their words, instructions for how to work (tone, what always needs their OK), new tasks for the recurring work their bar needs (title, instructions, a schedule that matches how often they want check-ins), library skills that fit, and a few lasting facts to remember.`,
        },
      ],
    },
  },
  {
    id: "blank",
    name: "Start from scratch",
    description: "A general agent. Tell it what it's for and shape it as you go.",
    profilePrompt: "Who you are, what you want this agent to help with, and anything it should always keep in mind.",
    instructions: "",
    skills: [],
    apps: [],
    tasks: [],
    setup: {
      intro: "I'll start by understanding what you're dealing with, suggest where I can help most, agree with you how to judge it and how to do it well, and then set myself up to work that way.",
      successExample: {
        vague: "Keep an eye on flight prices.",
        crisp: "Every Monday, the 3 cheapest nonstop round trips from Boston to Lisbon for the first two weeks of June under $700, with the airline and a link; ping me the same day if one drops below $550.",
      },
      usualHelp: "anything: keeping an eye on things, research, drafting, keeping a tracker",
      craft:
        "whatever the job, a good plan says where the information comes from and how fresh and trustworthy it is, how the best is picked out against their bar, what they get and when, and what stays with them",
      steps: [
        {
          id: "context",
          title: "What I should know",
          goal: `Gather only what you still need to carry out the plan: details, how often to check in if the bar doesn't say, any file worth keeping on hand (keep: true), and the 1-4 apps that would help most (a connect field). Design the form from what you know.`,
        },
        {
          id: "design",
          title: "How I'll work",
          goal: `Design this agent from scratch with propose_agent: a profile in their words, standing instructions built on their bar, the library skills that fit (by id), new tasks with schedules for anything recurring, and a few lasting facts to remember.`,
        },
      ],
    },
  },
];

export const DEFAULT_TEMPLATE_ID = "blank";

export function templateById(id: string | null | undefined): AgentTemplate | undefined {
  return id ? TEMPLATES.find((t) => t.id === id) : undefined;
}

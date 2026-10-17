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
   * In order, after SUCCESS_STEP (which every setup opens with); the agent runs one per reply
   * and skips what it already knows. The last one proposes the agent's setup.
   */
  steps: TemplateSetupStep[];
}

export interface TemplateSetupStep {
  id: string;
  /** A short checklist label, e.g. "Your résumé". */
  title: string;
  /** What to learn in this step and which card to show, written for the agent. */
  goal: string;
}

/**
 * The step every setup opens with: before anything is planned, the member says, as crisply as
 * a product manager writing acceptance criteria, what this agent must do and how they'll judge
 * it. The agent draws it out of them rather than offering a menu of things it could do, and the
 * proposal at the end is built on (and held to) what they confirm.
 */
export const SUCCESS_STEP: TemplateSetupStep = {
  id: "success",
  title: "What success looks like",
  goal: `Get the owner to define success crisply, the way a product manager writes acceptance criteria, before anything is planned. They have a specific job in mind, and this agent is only worth using if it does that job to their standard, so draw it out of them: don't offer a menu of things you could do, and don't suggest goals of your own. This step can take a few replies.
  a. show_form (intro: one sentence on why you're asking: so you can hold yourself to their bar) with required long_text fields "What's the one thing you most want me to do?", "Picture it going perfectly: what do you get from me, and when?", "How will you judge it? What makes a result great rather than just okay?", and "What would make you stop using me?", plus an optional long_text "Paste an example of a result you'd love (or one you'd hate)". Placeholders can hint at the crisp example below; never prefill these with your own guesses.
  b. Read their answers like a product manager. For each part that's vague or can't be checked ("good", "relevant", "high quality", "save me time", "a lot"), ask what it means to them: ask_user with 2-4 concrete readings drawn from their own words (they can type their own), or one show_form covering the vague parts. At most two rounds of this; then work with what they gave and say what's still loose. Never fill a gap with an assumption.
  c. Play it back: show_form titled "Your bar" with one list field (item_label "Criterion", parts: criterion (short), how we'll check it (long)) prefilled with 3-6 criteria in their words, each one a result could pass or fail (a number, a deadline, a yes/no), the deal-breakers among them. When they send it back, that's the bar: remember it in one line, and finish the step.
Coaching example for this kind of agent (an illustration only; their bar is their own): vague "{vague}"; crisp "{crisp}".`,
};

/** The setup steps an agent made from `template` runs, in order. */
export function setupSteps(template: AgentTemplate): TemplateSetupStep[] {
  const success = { ...SUCCESS_STEP, goal: SUCCESS_STEP.goal.replace("{vague}", template.setup.successExample.vague).replace("{crisp}", template.setup.successExample.crisp) };
  return [success, ...template.setup.steps];
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
- Don't apply or contact anyone. Reply with the new roles, best first, or say there were none.`,
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
      intro: "I'll learn exactly what a great job search looks like to you, read your résumé, help you get your stories ready, and then suggest how I'll run your search.",
      successExample: {
        vague: "Find me good jobs.",
        crisp: "Each weekday by 9am, 3-5 new senior product design roles: remote in the US, $180k+ base, B2B SaaS, posted in the last 3 days, none I've seen before, each with one line on why it fits. If I'd pass on more than 2 of every 5, it isn't working.",
      },
      steps: [
        {
          id: "resume",
          title: "Your résumé",
          goal: `Get their résumé onto this agent's files. If CONTEXT already lists a résumé among their files, say so and skip ahead. Otherwise show_form with a required file field (keep: true, accept pdf, docx, txt, md) and an optional long_text "Anything that isn't on it?". When it arrives, read it, and remember the few facts you'll lean on most (current role, years of experience, strongest areas).`,
        },
        {
          id: "search",
          title: "Your search",
          goal: `Pin down the search. show_form, prefilled from the résumé, their bar, and what they said: text "Target roles", choice "Seniority" (from their level, a step up, either), multi_choice "How do you want to work?" (Remote, Hybrid, On-site; they pick every one they'd take), text "Cities" (help: only for hybrid or on-site roles), text "Pay floor", long_text "Must-haves", long_text "Deal-breakers", text "Companies you'd love to work at", and a choice "How often should I check in?" (Every weekday, A few times a week, Weekly, Only when I ask; prefilled to match their bar if it says).`,
        },
        {
          id: "stories",
          title: "Your stories",
          goal: `Get interview stories ready. Draft 3-5 STAR stories from the résumé's strongest bullets (only facts that are there; leave a part empty rather than writing a placeholder), then show_form with one list field: item_label "Story", parts situation, task, action, result (long), and skills (short), prefilled with your drafts, for them to fix and add to. When they send it, save every story they sent right away, gaps and all (say which could use more detail), with save_record: collection "stories", key a short slug of its title, title a few words naming it, fields situation, task, action, result, skills. If CONTEXT has no tracker section, remember one sentence per story instead.`,
        },
        {
          id: "apps",
          title: "Your apps",
          goal: `Connect what you'll work in. show_form with a connect field for gmail, calendar, apollo and hunter (with help saying Gmail and Calendar are for replies and interviews, Apollo and Hunter for finding the right people), and another optional connect field for clay. Say they can skip any and connect later.`,
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
      intro: "I'll learn exactly what you need me to get right, how your business works, and the tools you run on, and then suggest what I'll take off your plate.",
      successExample: {
        vague: "Help with customer emails.",
        crisp: "Every customer email gets a reply drafted within 2 hours on weekdays, in my tone, with the right order details from Shopify; I send at least 4 of every 5 without editing, and nothing promising a refund goes out without me.",
      },
      steps: [
        {
          id: "business",
          title: "Your business",
          goal: `Learn the business. show_form, prefilled from what you know: long_text "What you sell and who buys it", text "Where you sell" (e.g. online store, shop, markets), long_text "How you talk to customers" (tone, sign-off), and an optional file field (keep: true) for a price list, menu, or policies.`,
        },
        {
          id: "apps",
          title: "Your tools",
          goal: `Connect what they run on. show_form with a connect field for gmail, shopify, sheets and quickbooks (help: say what you'd use each for), and say they can skip any and connect later.`,
        },
        {
          id: "rhythm",
          title: "When I work",
          goal: `Find when the work happens. show_form with a long_text "When does this work come up, and by when does it need doing?" (prefilled from their bar), a choice "How often should I check in?" (Every weekday, Weekly, Only when I ask), and an optional long_text "Anything else you dread doing each week?".`,
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
      intro: "Tell me the job you want done and how you'll judge it, and I'll suggest how to set myself up to meet that bar.",
      successExample: {
        vague: "Keep an eye on flight prices.",
        crisp: "Every Monday, the 3 cheapest nonstop round trips from Boston to Lisbon for the first two weeks of June under $700, with the airline and a link; ping me the same day if one drops below $550.",
      },
      steps: [
        {
          id: "context",
          title: "What I should know",
          goal: `Gather what you'll need to meet their bar: a show_form with up to 4 short fields that matter for it (prefilled from what you know), a choice "How often should I check in?" (Every weekday, Weekly, Only when I ask; prefilled to match their bar if it says), an optional file field (keep: true) for anything to keep on hand, and a connect field for the 1-4 apps that would help most.`,
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

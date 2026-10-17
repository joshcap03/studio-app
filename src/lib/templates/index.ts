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
  },
];

export const DEFAULT_TEMPLATE_ID = "blank";

export function templateById(id: string | null | undefined): AgentTemplate | undefined {
  return id ? TEMPLATES.find((t) => t.id === id) : undefined;
}

import type { AppId } from "@/lib/apps";

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
}

export const TEMPLATES: AgentTemplate[] = [
  {
    id: "job-search",
    name: "Job search",
    description: "Finds roles that fit, tailors applications, drafts outreach, and preps you for interviews.",
    profilePrompt:
      "The roles you're after (titles, seniority), where (cities, remote), your pay floor, must-haves and deal-breakers, and a few lines on your background. Add your résumé to a project.",
    instructions: `You run my job search with me, end to end.
- Keep a job tracker: a Google Sheet called "Job search tracker" with one row per role (company, title, link, score, status, next step, date). Statuses: discovered, shortlisted, applied, outreach, interviewing, offer, closed. Create it the first time you need it, then keep it current.
- Only ever use facts about me from my profile, files, and memory. Never invent experience or numbers.
- Applications, emails, and messages are drafts until I approve sending or submitting each one.
- When something is ambiguous about what I want, ask me one short question rather than guessing.`,
    skills: ["find-roles", "research-company", "tailor-application", "outreach-drafts", "interview-prep"],
    apps: ["gmail", "calendar", "docs", "sheets", "drive"],
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
  },
  {
    id: "blank",
    name: "Start from scratch",
    description: "A general agent. Tell it what it's for and shape it as you go.",
    profilePrompt: "Who you are, what you want this agent to help with, and anything it should always keep in mind.",
    instructions: "",
    skills: [],
    apps: [],
  },
];

export const DEFAULT_TEMPLATE_ID = "blank";

export function templateById(id: string | null | undefined): AgentTemplate | undefined {
  return id ? TEMPLATES.find((t) => t.id === id) : undefined;
}

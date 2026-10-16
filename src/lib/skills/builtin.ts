import { previewEnabled } from "@/lib/flags";
import type { Tenant } from "@/lib/tenant";
import type { WorkspaceSkill } from "@/lib/types";

// Skills every workspace has without adding them. They live in code, not the database, so
// their ids aren't uuids; like workspace skills, they only reach the agent on a message
// they're attached to. Business specifics come from the workspace's settings and memory.

const BUILTIN: WorkspaceSkill[] = [
  {
    id: "builtin:why",
    catalogId: null,
    name: "Investigate",
    description: "Dig into anything, in your connected apps or on the web (what happened, why, what's planned, or how another company is doing), with a timeline, charts, and key numbers.",
    instructions: `Investigate what the user asks about: why something happened, what's planned, where something stands, or anything else. Look things up only; never change anything.
1. Decide whose question it is. If it names another company, person, product, market, or public topic (anything that isn't the user's own business or accounts), it's about the outside world: research it with web search (the company's site, news, funding, job posts, reviews, filings), from several sources, and skip the user's apps unless the question ties back to them. Never assume a company the user names is their own business; their business is the one in your workspace context. If the question is about the user's own business, records, or plans, use their connected apps (steps 3-4). When it's both, do both.
2. Pin down the question and its time window. If the user didn't give one, use the one that fits best (for example, the last 7 days for something that happened, the dates they named for plans, or the last year for how a company is doing) and say which you used.
3. For the user's own business, check which apps are connected. Pick every one that could hold an answer: email (confirmations, bookings, receipts, supplier or customer messages), calendar (events, travel, closures, staff out), files and docs, sales and payments (orders, refunds, payouts), inventory and products, marketing, and anything else connected that fits. Don't stop at the first app that has something.
4. Read from each of those apps with execute_tool, searching for the people, places, names, and dates involved, and covering a few days around the window. If a read fails, try another way once (different search terms or a different tool) before giving up on that app. Never use take_action. If nothing connected can answer, say so in one line; don't stop there when the web can still help.
5. If you found dated records or events (in apps or on the web), call report_timeline with every relevant one, one entry per record, oldest first (bookings, confirmations, events, messages, launches, funding rounds, hires, changes). Give each the record's link exactly as the tool returned it (leave it empty if there was none). Only when the user asked why something happened, also list the likely causes, most likely first, each pointing at the entries that support it.
6. Show what the numbers and details say with report_visual, once per graphic, wherever one makes the answer clearer: a chart for numbers across days or categories (a line for a trend, bars to compare, with the period before for context), stats for the 2-6 numbers that matter most (with the change and whether it's good or bad news), or a table to compare things side by side (bookings, options, orders, people, companies). Use only numbers and facts the tools returned; never estimate or fill gaps. Skip it when there's nothing worth drawing.
7. Reply briefly with the answer: for a "why", the most likely causes and how confident you are; when the user asked for hypotheses or a read on something, give specific ones grounded in what you found, each with the evidence behind it; otherwise what you found, with the key dates and details. Then say what you couldn't check (apps not connected, or data you couldn't read). Don't repeat the whole timeline; the user sees it.`,
    createdAt: 0,
  },
];

export const BUILTIN_SKILL_IDS = BUILTIN.map((s) => s.id) as [string, ...string[]];

/** The built-in skills this member can use. */
export function builtinSkills(tenant: Tenant): WorkspaceSkill[] {
  return previewEnabled(tenant, "why") ? BUILTIN : [];
}

export function builtinSkill(tenant: Tenant, id: string): WorkspaceSkill | null {
  return builtinSkills(tenant).find((s) => s.id === id) ?? null;
}

import { getConfig } from "@/lib/config";
import { previewEnabled } from "@/lib/flags";
import type { Tenant } from "@/lib/tenant-core";
import type { WorkspaceSkill } from "@/lib/types";
import { INTRODUCE_SKILL_ID } from "./introduce";
import { TEACH_SKILL } from "./teach";
import { TIDY_SKILL_IDS } from "./tidy";

// Skills every workspace has without adding them. They live in code, not the database, so
// their ids aren't uuids; like workspace skills, they only reach the agent on a message
// they're attached to. Business specifics come from the workspace's settings and memory.

const BUILTIN: WorkspaceSkill[] = [
  {
    id: "builtin:why",
    catalogId: null,
    name: "Investigate",
    description: "Dig into anything across your connected apps (what happened, why, or what's planned) with a timeline, charts, and key numbers.",
    instructions: `Investigate what the user asks about by reading every connected app that could know: why something happened, what's planned, where something stands, or anything else. Look things up only; never change anything.
1. Pin down the question and its time window. If the user didn't give one, use the one that fits best (for example, the last 7 days for something that happened, or the dates they named for plans) and say which you used.
2. Check which apps are connected. Pick every one that could hold an answer: email (confirmations, bookings, receipts, supplier or customer messages), calendar (events, travel, closures, staff out), files and docs, sales and payments (orders, refunds, payouts), inventory and products, marketing, and anything else connected that fits. Don't stop at the first app that has something.
3. Read from each of those apps with execute_tool, searching for the people, places, names, and dates involved, and covering a few days around the window. If a read fails, try another way once (different search terms or a different tool) before giving up on that app. Never use take_action.
4. If you found dated records, call report_timeline with every relevant one, one entry per record, oldest first (bookings, confirmations, events, messages, changes). Give each the record's link exactly as the tool returned it (leave it empty if there was none). Only when the user asked why something happened, also list the likely causes, most likely first, each pointing at the entries that support it.
5. Show what the numbers and details say with report_visual, once per graphic, wherever one makes the answer clearer: a chart for numbers across days or categories (a line for a trend, bars to compare, with the period before for context), stats for the 2-6 numbers that matter most (with the change and whether it's good or bad news), or a table to compare things side by side (bookings, options, orders, people). Use only numbers and facts the tools returned; never estimate or fill gaps. Skip it when there's nothing worth drawing.
6. Reply briefly with the answer: for a "why", the most likely causes and how confident you are; otherwise what you found, with the key dates and details. Then say what you couldn't check (apps not connected, or data you couldn't read). Don't repeat the whole timeline; the user sees it.`,
    createdAt: 0,
  },
];

// "builtin:setup" is every agent's setup interview (./setup.ts), loaded per template by getSkill,
// "builtin:tidy:<topic>" tidies one topic of the Brain (./tidy.ts), started from the Brain, and
// "builtin:introduce" is the agent introducing itself once it knows the member (./introduce.ts), and
// "builtin:teach" is "Show me once", learning a job by watching the member do it (./teach.ts).
export const BUILTIN_SKILL_IDS: [string, ...string[]] = ["builtin:setup", INTRODUCE_SKILL_ID, ...TIDY_SKILL_IDS, ...BUILTIN.map((s) => s.id), TEACH_SKILL.id];

/**
 * The built-in skills this member can use. "Show me once" needs the agent's hosted browser, which
 * the member drives through Studio, and ends in a new skill, which only the owner can save.
 */
export function builtinSkills(tenant: Tenant): WorkspaceSkill[] {
  const teach = getConfig().browser && tenant.workspace.role === "owner" ? [TEACH_SKILL] : [];
  return [...(previewEnabled(tenant, "why") ? BUILTIN : []), ...teach];
}

export function builtinSkill(tenant: Tenant, id: string): WorkspaceSkill | null {
  return builtinSkills(tenant).find((s) => s.id === id) ?? null;
}

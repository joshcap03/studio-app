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
    name: "Investigate why",
    description: "Find out why something happened, with a timeline of what each app shows.",
    instructions: `Investigate why the thing the user asks about happened. Look things up only; never change anything.
1. Pin down what changed and when. If the user didn't say the time window, use the most recent one that fits (for example, "yesterday" or the last 7 days) and say which you used.
2. Check which apps are connected. Pick the ones that could explain it: sales and payments (orders, refunds, disputes, payouts), inventory and products (stockouts, price changes), email (supplier delays, customer complaints), calendar (closures, staff out), marketing (campaigns that ended), and anything else connected that fits.
3. Read from each of those apps with execute_tool, covering the window and a few days before it. Never use take_action.
4. Call report_timeline with every relevant dated event you found, one per record, oldest first. Give each the record's link exactly as the tool returned it (leave it empty if there was none). Then list the likely causes, most likely first, each pointing at the entries that support it.
5. Reply briefly: the most likely causes, how confident you are and why, and what you couldn't check (apps not connected, or data you couldn't read). Don't repeat the whole timeline; the user sees it.`,
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

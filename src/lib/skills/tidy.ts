import { MEMORY_CATEGORIES, MEMORY_CATEGORY_LABELS, type Memory, type MemoryCategory, type WorkspaceSkill } from "@/lib/types";

// "Tidy up" on a Brain topic: a built-in skill, one per topic, that gives the agent the facts
// in that topic the member may change, by id, and asks it to propose combining the ones that
// overlap with merge_memories (a generic card; see src/lib/memory-merge.ts). The agent only
// proposes; the member merges, and can undo it. Nothing here knows what any agent is for.

export const TIDY_SKILL_NAME = "Tidy up memory";
const PREFIX = "builtin:tidy:";

export const TIDY_SKILL_IDS = MEMORY_CATEGORIES.map((c) => `${PREFIX}${c}`);

export function tidySkillId(category: MemoryCategory): string {
  return `${PREFIX}${category}`;
}

/** The topic a tidy skill id is for, or null when it isn't one. */
export function tidyCategory(id: string): MemoryCategory | null {
  return MEMORY_CATEGORIES.find((c) => id === `${PREFIX}${c}`) ?? null;
}

/** The most facts one tidy-up reads, newest first, within this much text. */
export const TIDY_MAX_FACTS = 150;
const TIDY_BUDGET = 30_000;

/** What the member sends with the skill: a request naming the topic. */
export function tidyRequest(category: MemoryCategory): string {
  return `Tidy up what you know about ${MEMORY_CATEGORY_LABELS[category]}.`;
}

const RULES = `Tidy up what this agent remembers in one topic: combine facts that overlap or repeat into fewer, clearer ones, and propose that with merge_memories. Change nothing else.
- Merge facts that say the same thing, or that are about the same specific subject and read better as one (for example, three facts each naming a few organizations that count as top tier become one fact naming them all). Leave a fact that stands on its own alone; never merge just to make the list shorter.
- Merge a fact with the newer ones that change, cancel, or restate it (a plan revised, something cut or decided since, the same point said again in other words), so one fact says what's true now.
- A merged fact keeps every detail of the facts it replaces that's still true: names, numbers, conditions, exceptions, and who or what it's about. Never soften or add a detail. Where facts disagree, the newer one's version wins (facts are listed newest first); drop only what a newer fact overrides, and name what you dropped in your reply.
- Write each merged fact as one or two plain, self-contained sentences, at most 500 characters. Split a subject into two merges rather than writing a long one.
- Shared facts merge only with shared facts, and facts only the member sees only with each other.
- Name facts only by their ids below, exactly as written, without the brackets. Each fact goes in one merge at most.
- Call merge_memories once, with every merge, then end your reply with one or two sentences: how many facts become how many, and anything that overlapped but you left alone, and why. The member reviews the merges and nothing changes until they do; don't say it's done. If nothing overlaps, don't call it: say the topic is already tidy.
- Don't call remember or anything else while tidying.`;

/**
 * The tidy skill for one topic, from the facts the member can see. Only facts they may change
 * are listed (their own, or any shared fact for an owner), shared ones first.
 */
export function tidySkill(category: MemoryCategory, memories: Memory[], { owner }: { owner: boolean }): WorkspaceSkill {
  const changeable = memories
    .filter((m) => m.category === category && (m.mine || owner))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, TIDY_MAX_FACTS);
  let used = 0;
  const listed = changeable.filter((m) => (used += m.content.length + 40) <= TIDY_BUDGET);
  const lines = (scope: Memory["scope"]) =>
    listed.filter((m) => m.scope === scope).map((m) => `- [${m.id}]${m.pinned ? " (pinned)" : ""} ${m.content}`);
  const shared = lines("workspace");
  const personal = lines("personal");
  const total = memories.filter((m) => m.category === category && (m.mine || owner)).length;
  const sections = [
    shared.length ? `Shared facts (everyone using this agent sees them):\n${shared.join("\n")}` : "",
    personal.length ? `Facts only the member sees:\n${personal.join("\n")}` : "",
  ].filter(Boolean);
  const more = total > listed.length ? `\n\nThese are the newest ${listed.length} of ${total} facts in this topic; tidy these, and the rest can be tidied next time.` : "";
  return {
    id: tidySkillId(category),
    catalogId: null,
    name: TIDY_SKILL_NAME,
    description: "Combine overlapping facts in one topic of the Brain into fewer, clearer ones, for you to review.",
    instructions: `${RULES}

Topic: ${MEMORY_CATEGORY_LABELS[category]}

${sections.length ? sections.join("\n\n") : "There are no facts in this topic the member can change. Say so, and don't call merge_memories."}${more}`,
    createdAt: 0,
  };
}

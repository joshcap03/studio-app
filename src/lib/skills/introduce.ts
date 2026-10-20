import type { WorkspaceSkill } from "@/lib/types";

// "Say hello": once an agent knows its member (src/lib/companion.ts), it introduces itself
// properly and suggests a name for itself. It uses only the general-purpose proposal card
// (propose_agent with identity), so nothing here is UI for one template or one agent. The
// member keeps the name or picks another; nothing changes until they do.

export const INTRODUCE_SKILL_ID = "builtin:introduce";
export const INTRODUCE_SKILL_NAME = "Say hello";

export function introduceSkill({
  member,
  voiceName,
  manner,
  taken,
}: {
  /** What the member goes by, if known. */
  member: string | null;
  /** The name they've heard on calls, if they've had any. */
  voiceName: string | null;
  /** How it already talks with them, if they have one (chosen when it was set up, say); it stays. */
  manner?: string | null;
  /** Names their other agents already go by. */
  taken: string[];
}): WorkspaceSkill {
  const them = member ?? "them";
  const avoid = [member && `${member} (their own name)`, ...taken.map((t) => `${t} (another of their agents)`)].filter(Boolean);
  const instructions = `Introduce yourself to ${them} properly. You've worked together long enough to know a little about how they work, and this is where you become someone to them, so keep it warm, true and short. Speak first; this message has no words of theirs.
- Three or four short sentences, with no list and no heading:
  1. A natural hello${member ? `, using ${member}` : ""}.
  2. One or two specific, true things you've noticed about how they work or what matters to them. Take them only from CONTEXT (about them, what this agent is for, its instructions, what you remember, their bar, their files) and past conversations you can see. Never invent, guess or flatter. Keep to their work: leave health, relationships, money details and anything else personal out unless they raised it with you. If you have nothing specific yet, say plainly that you're still learning how they like to work.
  3. One sentence on how you'll show up for them, drawn from what they've told you matters.
- Then call propose_agent with a one-sentence summary and only identity:
  - name: a short, warm, human first name that fits who you've been for them.${voiceName ? ` They've heard you as "${voiceName}" on calls, so suggest keeping "${voiceName}" unless another name clearly fits better.` : ""}${avoid.length ? ` Not ${avoid.join(", or ")}.` : ""}
  - manner: ${manner ? `how you already talk with them, word for word: "${manner}" It's theirs and stays as it is, so don't reword it.` : "two first-person sentences on how you talk with them (how brief you are, how you bring news, what you always do first), true to how they like to work."}
- End right after the card with one short sentence: they can keep the name or pick their own. Don't call anything else, and don't mention tools, setup or anything behind the scenes.`;
  return { id: INTRODUCE_SKILL_ID, catalogId: null, name: INTRODUCE_SKILL_NAME, description: "The agent introduces itself and suggests a name.", instructions, createdAt: 0 };
}

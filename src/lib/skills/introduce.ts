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
  // The card shows under the whole message with the name, the manner and a Keep button, so the
  // name is offered in the one sentence after the call: it lands right above the card.
  const instructions = `Introduce yourself to ${them}. You've worked together for a while, and this is where you become someone to them: a short, warm hello from a colleague, not a summary of what you know about them. Speak first; this message has no words of theirs.
- Two or three short sentences, with no list and no heading:
  1. A natural hello${member ? `, using ${member}` : ""}.
  2. One or two sentences on the work you've been doing together, the way a colleague would put it, not a status report: what you've been after together, with one or two specifics woven in. Take it only from CONTEXT (what this agent is for, the tracker, the Library, the task, what you remember). Never invent, guess or flatter, and don't point out what's empty or missing (an empty tracker, no files). If there's little to go on yet, say plainly that you're still getting to know how they like to work.
- Don't read their instructions, preferences or rules back to them, don't say you've noticed things about them, and don't promise how you'll work or what you'll leave to them: they know what they told you, and a hello that recites it reads like a checklist. Keep to their work: leave health, relationships, money and anything else personal out.
- Then call propose_agent with a one-sentence summary and only identity:
  - name: one short, warm word that fits the work you do together (what this agent is for, in CONTEXT), so it reads as this agent's at a glance beside their others: a first name or an everyday word with a clear nod to the job, the way a travel agent might go by Miles or a bookkeeper by Penny. Not a generic assistant name (Assistant, Helper, Buddy) and not the job's own title.${voiceName ? ` They've heard you as "${voiceName}" on calls, so keep "${voiceName}" unless another name clearly fits better.` : ""}${avoid.length ? ` Not ${avoid.join(", or ")}.` : ""}
  - manner: ${manner ? `how you already talk with them, word for word: "${manner}" It's theirs and stays as it is, so don't reword it.` : "two short first-person sentences on your tone with them (how brief you are, how you bring news), in different words from your hello. Tone only: nothing on what you will or won't do for them or what you leave to them, since their rules already say that."}
- The card shows under your message with the name and a button to keep it. After the call, end with one sentence offering the name in your own words, as a person would, with a few words on how it fits the work ("I'd like to go by …, since …, if that suits you.")${voiceName ? `; if it's "${voiceName}", say they've heard you by it on calls instead` : ""}. Don't name yourself before the call or write anything else after it, don't call anything else, and don't mention tools, setup or anything behind the scenes.`;
  return { id: INTRODUCE_SKILL_ID, catalogId: null, name: INTRODUCE_SKILL_NAME, description: "The agent introduces itself and suggests a name.", instructions, createdAt: 0 };
}

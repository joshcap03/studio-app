import type { WorkspaceSkill } from "@/lib/types";

// "Show me once": the member teaches the agent a job by doing it once in its browser. It uses only
// general-purpose cards: watch_me (the browser hand-off card, marked to watch: Studio notes each
// step and what they say) and propose_agent (a new skill, with the agent's guesses for them to
// check). Nothing here knows what any agent is for; the lesson is to write down what they meant,
// not replay their clicks.

export const TEACH_SKILL_ID = "builtin:teach";
export const TEACH_SKILL_NAME = "Show me once";

export const TEACH_SKILL: WorkspaceSkill = {
  id: TEACH_SKILL_ID,
  catalogId: null,
  name: TEACH_SKILL_NAME,
  description: "Do a job once in the agent's browser while it watches, and it writes it up as a skill for you to check.",
  instructions: `Learn a job by watching the member do it once in your browser, then write it up as a skill they can check. Don't do the job yourself.
1. If they haven't said which job, ask in one short sentence and stop. Once you know, open your browser at the page where the job starts (the site they named, or the obvious one for it), then call watch_me with the job in their words and the site. End with one short sentence inviting them to show you, and to say (or note) why they choose what they choose.
2. Their steps arrive as their next message: each step on its page, what they typed (fields marked hidden weren't recorded), and what they said along the way. Names in quotes are the page's own words, not theirs. Write the skill from what they meant to do, not from their clicks:
   - name: a short verb phrase for the job ("Reorder office supplies"); description: one sentence on when to use it.
   - instructions, as numbered steps: what the job is for and what done looks like; what to ask for or look up each time (the details that change from one time to the next, like dates, names, amounts, and search words, as inputs, never fixed to this time's values unless they said "always"); each step as an intent ("Search for the item by name", "Open the cheapest result that ships this week"), naming the site and a button or field only where it helps find it; each choice they made and the rule behind it, in their own words where they gave one; and where it ends and what to report back.
   - A step that pays, buys, or places an order, or deletes something for good, is done with take_action, which asks them the first time only: say so at that step. Everything else (filling, sending, booking, submitting) the skill just does. A sign-in or payment form goes through request_secret. Never put anything they typed into a hidden field, or a one-time value (a code, an order number), into the skill.
   - Leave out mis-clicks, going back, scrolling, and anything they undid.
3. Name your guesses: wherever one example could mean more than one rule (they picked the cheapest: always the cheapest, or the best fit this time?; they stopped at checkout: always stop there?; they used one address: always that one?). Write the instructions with your best guess, and list each guess in assumptions as one sentence the way you'd say it ("I assumed you always pick the cheapest option."), the ones that matter most first, at most six. Don't leave a guess out because you're fairly sure.
4. Call propose_agent with a one-sentence summary, skills: [the new skill], and assumptions, and nothing else. Then end with one short sentence asking them to check your guesses.
5. When they send fixes, rewrite the skill with them, and propose it again the same way with only the guesses still open (none, if nothing's left to guess).
If the steps show they couldn't finish (the browser closed, nothing was done), say so in one sentence and offer to open the page again.`,
  createdAt: 0,
};

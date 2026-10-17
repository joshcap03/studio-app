import { describeSchedule } from "@/lib/tasks/schedule";
import { DEFAULT_TEMPLATE_ID, setupSteps, templateById, type AgentTemplate } from "@/lib/templates";
import type { WorkspaceSkill } from "@/lib/types";
import { CATALOG } from "./catalog";

// The setup interview every agent opens with: one built-in skill whose steps come from the
// agent's template. It uses only the agent's general-purpose cards (show_form, ask_user,
// propose_agent), so nothing here is UI for one template; the template only says what to ask.
// Every interview opens by having the owner define success (SUCCESS_STEP), and the proposal
// it ends with is built on, and holds every later run to, the bar they confirmed.

export const SETUP_SKILL_ID = "builtin:setup";
export const SETUP_SKILL_NAME = "Set up this agent";

const RULES = `Start your reply with "Hey!".
Set this agent up with the owner, as a short interview, so it works the way they need from here on.
- Your very first reply (and only that one) begins with the word "Hey!" in its text, then one sentence on what you'll do together and that it takes about {count} quick steps, then step 1's form or question.
- Go through the steps below in order, one step per reply ("What success looks like" takes a few). Each reply is a sentence or two, then one show_form (ask_user for a single quick choice), and then stop: their answers arrive as their next message.
- Make every answer a reaction, not a chore: draft the likely answers as choices (allow_other so they can say something else), use scale for "how much", rank for "what matters most", and verdict for "would you want this?". Use an empty text box only for what only they can say.
- "What success looks like" sets their bar: what they need this agent to do and how they'll judge it. Don't plan, suggest tasks, or design anything until they've confirmed it, and build every later step on it. Use what earlier steps taught you (e.g. their résumé) to draft its choices and run its trial.
- Before each step, check what you already know (CONTEXT: about them, what this agent is for, its instructions, memory, their files, the tracker). Prefill the form with it, and skip a step that's already answered (say so in a few words).
- Read any file they add before the next step. Use only facts from their files and answers; never invent experience, numbers, or preferences.
- Remember lasting facts as you learn them, with remember, as usual.
- On your first reply, call update_plan with one step per setup step below (the current one "doing", the rest "todo"), and update it each time a step finishes or is skipped. Give each finished step a note: what it gave you, in a few words from their answers (e.g. "Bar set: 6 criteria, 3 deal-breakers", "Résumé read: 8 years in B2B SaaS design"); a skipped step's note says it was skipped.
- If they want to stop, skip a step, or change course, do that.
- Finish with propose_agent, then stop. Its instructions open with a "What success means" section: their confirmed criteria and deal-breakers in their words, then "Check every result against these before you send it, and say plainly which one it misses." Every task you propose serves one of the criteria, and its instructions end with: "Finish by showing the results in a show_form verdict field (title, one line on why it fits, link), with 3-5 reasons I might pass, so I can keep or pass on each." In your reply, say for each criterion how you'll meet it, and be honest about any you can't meet yet (a missing app, data, or ability) and what would close the gap; never promise more than you can do. Nothing changes until they apply it, so never say you're set up; say what they'll get once they apply it, and that once they do, "Do the first one now" runs the first task for real.`;

function steps(template: AgentTemplate): string {
  // Step 1 repeats how the first reply opens, where the agent is looking when it writes it.
  return setupSteps(template)
    .map((s, i) => `${i + 1}. ${s.title}: ${i === 0 ? 'Your reply begins "Hey!" (see above). ' : ""}${s.goal}`)
    .join("\n");
}

function templateTasks(template: AgentTemplate): string {
  if (template.tasks.length === 0) return "";
  const lines = template.tasks.map(
    (t) => `- ${t.id}: ${t.title} (${t.schedule ? describeSchedule(t.schedule, "UTC") : "on demand"}${t.skill ? `, skill ${t.skill}` : ""})`,
  );
  return `\n\nTasks this agent already has, paused (switch them on in propose_agent by template_task_id; times are in the owner's time zone):\n${lines.join("\n")}`;
}

function library(): string {
  return `\n\nLibrary skills you can propose (by id):\n${CATALOG.map((e) => `- ${e.id}: ${e.name}. ${e.description}`).join("\n")}`;
}

/** The setup skill for an agent made from `templateId` (the blank template when unknown). */
export function setupSkill(templateId: string | null | undefined): WorkspaceSkill {
  const template = templateById(templateId) ?? templateById(DEFAULT_TEMPLATE_ID)!;
  return {
    id: SETUP_SKILL_ID,
    catalogId: null,
    name: SETUP_SKILL_NAME,
    description: template.setup.intro,
    instructions: `${RULES.replace("{count}", String(setupSteps(template).length))}

This agent started from the "${template.name}" template. ${template.setup.intro}

Steps:
${steps(template)}${templateTasks(template)}${library()}`,
    createdAt: 0,
  };
}

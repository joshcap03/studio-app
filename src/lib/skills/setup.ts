import { describeSchedule } from "@/lib/tasks/schedule";
import { DEFAULT_TEMPLATE_ID, templateById, type AgentTemplate } from "@/lib/templates";
import type { WorkspaceSkill } from "@/lib/types";
import { CATALOG } from "./catalog";

// The setup interview every agent opens with: one built-in skill whose steps come from the
// agent's template. It uses only the agent's general-purpose cards (show_form, ask_user,
// propose_agent), so nothing here is UI for one template; the template only says what to ask.

export const SETUP_SKILL_ID = "builtin:setup";
export const SETUP_SKILL_NAME = "Set up this agent";
/** What the member's opening message says when they start (or rerun) setup. */
export const SETUP_KICKOFF = "Let's set you up.";

const RULES = `Set this agent up with the owner, as a short interview, so it works the way they need from here on.
- Go through the steps below in order, one step per reply. Each reply is a sentence or two, then one show_form (ask_user for a single quick choice), and then stop: their answers arrive as their next message.
- Before each step, check what you already know (CONTEXT: about them, what this agent is for, its instructions, memory, their files, the tracker). Prefill the form with it, and skip a step that's already answered (say so in a few words).
- Read any file they add before the next step. Use only facts from their files and answers; never invent experience, numbers, or preferences.
- Remember lasting facts as you learn them, with remember, as usual.
- On your first reply, call update_plan with one step per setup step below (the current one "doing", the rest "todo"), and update it each time a step finishes or is skipped.
- If they want to stop, skip a step, or change course, do that.
- Finish with propose_agent, then stop. Nothing changes until they apply it, so never say you're set up; say what they'll get once they apply it.
- Your first reply: "Hey!", one sentence on what you'll do together and that it takes about {count} quick steps, then step 1.`;

function steps(template: AgentTemplate): string {
  return template.setup.steps.map((s, i) => `${i + 1}. ${s.title}: ${s.goal}`).join("\n");
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
    instructions: `${RULES.replace("{count}", String(template.setup.steps.length))}

This agent started from the "${template.name}" template. ${template.setup.intro}

Steps:
${steps(template)}${templateTasks(template)}${library()}`,
    createdAt: 0,
  };
}

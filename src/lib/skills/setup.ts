import { describeSchedule } from "@/lib/tasks/schedule";
import { DEFAULT_TEMPLATE_ID, SUCCESS_STEP, setupSteps, templateById, type AgentTemplate } from "@/lib/templates";
import type { WorkspaceSkill } from "@/lib/types";
import { CATALOG } from "./catalog";

// The setup interview every agent opens with: one built-in skill whose steps come from the
// agent's template. It uses only the agent's general-purpose cards (show_form, ask_user,
// propose_agent), so nothing here is UI for one template; the template only says what to ask.
// Every interview opens by having the owner define success (SUCCESS_STEP), and the proposal
// it ends with is built on, and holds every later run to, the bar they confirmed.

export const SETUP_SKILL_ID = "builtin:setup";
export const SETUP_SKILL_NAME = "Set up this agent";

const RULES = `Start your first reply in this setup with "Hey" and their first name when you know it ("Hey Sam!", or just "Hey!"); only that one, later replies just carry on.
Set this agent up with the owner, carefully and methodically, the way a good product thinker or advisor would: first understand the challenges they really need help with and advise them where you can help, then agree how success will be judged, then design how you'll work.
- Your very first reply (and only that one) begins with that greeting, then one sentence on what you'll do together (understand what's hard for them, suggest where you can help, agree how to judge it, then set yourself up), then your first open question about their situation. No form in the first reply.
- Keep them oriented the whole way, so they never wonder where the setup is or what to do next. Each reply opens with what you heard, briefly in their own words ("So the hard part is reaching people, not finding roles."), and ends with exactly one question for them, or, when a card is on screen, what to do with it; never two questions. Once they've agreed a step is done, say so in a few words and name the next one. Orienting them isn't deciding for them: where you'd give a view, their own rules about advice come first.
- Before something they'll wait on (reading a file they gave you, a search), say in one short sentence what you're doing for them ("Let me read your résumé, so I don't ask what's already in it."). Keep your checklist and memory quietly: never mention updating them.
- Go step by step. Discovery is a conversation of plain questions; later steps may take a form each, which you design for what you've learned (a few fields; scale for "how much", rank for "what matters most", verdict for "would you want this?"). Multiple choice often misses what someone really means, so use it only for real, distinct alternatives drafted from their own words (every choice field also takes their own answer), and ask open questions when the answer is personal. After a form or question, stop: their answer arrives as their next message.
- The steps below are a guide, not a script: skip or merge any that what they're after doesn't need (say so in a few words), and never ask what you already know (CONTEXT: about them, what this agent is for, its instructions, memory, their files, the tracker).
- Don't plan, suggest tasks, or design anything until they've agreed on their problem and confirmed their bar, and build every later step on both.
- Read any file they add before the next step. Use only facts from their files and answers; never invent experience, numbers, or preferences.
- Remember lasting facts as you learn them, with remember, as usual.
- Keep their checklist with update_plan, and put on it only what you know you'll do. On your first reply it has two steps: understanding what they're after ("doing") and agreeing how success will be judged ("todo"). Add the others only once you know they're needed, named for their problem: what a fair trial needs (like their résumé) once they've agreed on their problem, then the rest of the setup once they've confirmed their bar, ending with your proposal. Never list a step their problem doesn't need, and never show them the whole guide below as their plan; if the checklist so far lists steps you don't yet know you'll need, cut it back on your next update_plan, keeping finished steps and their notes. Update it as steps finish. Give each finished step a note: what it gave you, in a few words from their answers (e.g. "Need: fewer, better-fitting roles, not more applications", "Bar set: 5 criteria").
- If they want to stop, skip a step, or change course, do that.
- Offer an app only with a connect field in a form (never composio_manage_connections during setup), and each app once: if they skip it, carry on without it and name the gap in your proposal.
- Setup is never done mid-conversation: don't start doing the job beyond the trial run, and don't save results to the tracker before they apply. Your setup is proposed only by calling propose_agent; never say it's ready, drafted, or proposed in a reply that doesn't call it.
- Finish with propose_agent, then stop. Its instructions open with a "What success means" section: their confirmed criteria and deal-breakers in their words, then "Check every result against these before you send it, and say plainly which one it misses." Every task you propose serves one of the criteria, and its instructions end with: "Finish by showing the results in a show_form verdict field (title, one line on why it fits, link), with 3-5 reasons I might pass, so I can keep or pass on each." In your reply, say for each criterion how you'll meet it, and be honest about any you can't meet yet (a missing app, data, or ability) and what would close the gap; never promise more than you can do. Nothing changes until they apply it, so never say you're set up; say what they'll get once they apply it, and that once they do, "Do the first one now" runs the first task for real.`;

function steps(template: AgentTemplate): string {
  // Step 1 repeats how the first reply opens, where the agent is looking when it writes it; the
  // steps after the bar say so, so none goes on their checklist before they've confirmed it.
  const bar = setupSteps(template).findIndex((s) => s.id === SUCCESS_STEP.id);
  return setupSteps(template)
    .map((s, i) => {
      const lead = i === 0 ? "Your first reply opens with your greeting (see above). " : i > bar ? "Only once their bar is confirmed (not on their checklist before then). " : "";
      return `${i + 1}. ${s.title}: ${lead}${s.goal}`;
    })
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

What setup may cover, in order (your guide, not their checklist):
${steps(template)}${templateTasks(template)}${library()}`,
    createdAt: 0,
  };
}

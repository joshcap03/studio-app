import { describeSchedule } from "@/lib/tasks/schedule";
import { DEFAULT_TEMPLATE_ID, SUCCESS_STEP, setupSteps, templateById, type AgentTemplate } from "@/lib/templates";
import type { WorkspaceSkill } from "@/lib/types";
import { voiceMenu } from "@/lib/voice/voices";
import { CATALOG } from "./catalog";

// The setup interview every agent opens with: one built-in skill whose steps come from the
// agent's template. It uses only the agent's general-purpose cards (show_form, ask_user,
// propose_agent), so nothing here is UI for one template; the template only says what to ask.
// Every interview opens by having the owner define success (SUCCESS_STEP), and the proposal
// it ends with is built on, and holds every later run to, the bar they confirmed.

export const SETUP_SKILL_ID = "builtin:setup";
export const SETUP_SKILL_NAME = "Set up this agent";

/**
 * How the interview opens: typed, with a greeting and what you'll do together; on a call, where
 * the voice has greeted them already, with just the question (and no template intro to recite).
 */
const OPENERS = {
  text: {
    start: `Start your first reply in this setup with "Hey" and their first name when you know it ("Hey Sam!", or just "Hey!"); only that one, later replies just carry on.`,
    first: `Your very first reply (and only that one) begins with that greeting, then one sentence on what you'll do together (understand what's hard for them, suggest where you can help, agree how to judge it and how to do it well, then set yourself up), then your first open question about their situation.`,
    lead: "Your first reply opens with your greeting (see above). ",
  },
  call: {
    start: "This setup happens on a live call, and the voice has already greeted them.",
    first: "Your very first reply is just your first open question about their situation, in one sentence: no greeting, nothing on how you'll work together, and nothing more once you've kept your books.",
    lead: "Your first reply is just your first question (see above). ",
  },
};

type Opener = (typeof OPENERS)["text"];

const rules = (opener: Opener) => `${opener.start}
Set this agent up with the owner, carefully and methodically, the way a good product thinker or advisor would: first understand the challenges they really need help with and advise them where you can help, then agree how success will be judged, then work out together how to do the job well, and only then design how you'll work. Give how to do it well as much care as the bar.
- ${opener.first} No form in the first reply.
- Keep them oriented the whole way, so they never wonder where the setup is or what to do next. Each reply opens with what you heard, briefly in their own words ("So the hard part is reaching people, not finding roles."), and ends with exactly one question for them, or, when a card is on screen, what to do with it; never two questions. Once they've agreed a step is done, say so in a few words and name the next one. Orienting them isn't deciding for them: where you'd give a view, their own rules about advice come first.
- When you advise where you can help, count everything you can do for them, your browser included when you have one: work they do by hand on a website (filling in forms, checking out with their card through the secure card) is work you can take over, so offer it, and never say you can't use a site.
- Before something they'll wait on (reading a file they gave you, a search), say in one short sentence what you're doing for them ("Let me read your résumé, so I don't ask what's already in it."). Keep your checklist and memory quietly: never mention updating them.
- Go step by step. Discovery is a conversation of plain questions; later steps may take a form each, which you design for what you've learned (a few fields; scale for "how much", rank for "what matters most", verdict for "would you want this?"). Multiple choice often misses what someone really means, so use it only for real, distinct alternatives drafted from their own words (every choice field also takes their own answer; use multi_choice whenever more than one could be true, like what counts as urgent), and ask open questions when the answer is personal. After a form or question, stop: their answer arrives as their next message.
- The steps below are a guide, not a script: skip or merge any that what they're after doesn't need (say so in a few words), and never ask what you already know (CONTEXT: about them, what this agent is for, its instructions, memory, their files, the tracker).
- Don't show a form, plan, suggest tasks, or design anything until they've answered your advice and agreed on their problem; don't plan, suggest tasks, or design anything until they've also confirmed their bar, and propose nothing until they've also confirmed how you'll do it. Build every later step on all three.
- Read any file they add before the next step. Use only facts from their files and answers; never invent experience, numbers, or preferences.
- Remember lasting facts as you learn them, with remember, as usual.
- Keep their checklist with update_plan, and put on it only what you know you'll do. On your first reply it has three steps: understanding what they're after ("doing"), agreeing how success will be judged ("todo"), and working out how to do it well ("todo"). Add the others only once you know they're needed, named for their problem: what a fair trial needs (like their résumé) once they've agreed on their problem, then the rest of the setup once they've confirmed their bar, ending with your proposal. Never list a step their problem doesn't need, and never show them the whole guide below as their plan; if the checklist so far lists steps you don't yet know you'll need, cut it back on your next update_plan, keeping finished steps and their notes. Update it as steps finish. Give each finished step a note: what it gave you, in a few words from their answers (e.g. "Need: fewer, better-fitting roles, not more applications", "Bar set: 5 criteria").
- If they want to stop, skip a step, or change course, do that.
- Offer apps only once they've confirmed the plan, never before (not in discovery, the bar, or the trial), and only the ones the plan needs. Offer an app only with a connect field in a form (never composio_manage_connections during setup), and each app once: if they skip it (their answer says it's not connected), don't offer it again or ask why; carry on without it and name the gap in your proposal.
- Setup is never done mid-conversation: don't start doing the job beyond the trial run, and don't save results to the tracker before they apply. Your setup is proposed only by calling propose_agent; never say it's ready, drafted, or proposed in a reply that doesn't call it.
- Finish with propose_agent, then stop. Its profile says in a few lines what this agent is for, from what they told you in discovery, unless CONTEXT already says it well. Its instructions open with a "What success means" section: their confirmed criteria and deal-breakers in their words and nothing else (how you'll get there belongs in the plan, not here), then "Check every result against these before you send it, and say plainly which one it misses." Next comes a "How I'll do it" section: the plan they confirmed, step by step, with their advice in it. Every task you propose serves one of the criteria and follows the plan, and its instructions say what it does the way you agreed, changes in their apps included (labeling or sorting their mail, sending replies, updating a sheet): those run without asking. Only paying, moving money, or deleting for good asks, and only the first time for each kind: once they approve it, later runs don't ask; say so in your reply when a task you propose does one. The trial's limits (read only, change nothing) were for the trial alone: never write a task as read-only or "change nothing" unless they asked for that. A task that brings them results to choose from (roles, leads, ideas) ends with: "Finish by showing the results in a show_form verdict field (title, one line on why it fits, link), with 3-5 reasons I might pass, so I can keep or pass on each." A task that does the work itself ends with a short report of what it did and what's waiting on them instead. In your reply, say for each criterion how you'll meet it, and be honest about any you can't meet yet (a missing app, data, or ability) and what would close the gap; never promise more than you can do. Nothing changes until they apply it, so never say you're set up; say what they'll get once they apply it, and that once they do, "Do the first one now" runs the first task for real.`;

function steps(template: AgentTemplate, opener: Opener): string {
  // Step 1 repeats how the first reply opens, where the agent is looking when it writes it; the
  // steps after the bar say so, so none goes on their checklist before they've confirmed it.
  const bar = setupSteps(template).findIndex((s) => s.id === SUCCESS_STEP.id);
  return setupSteps(template)
    .map((s, i) => {
      const lead = i === 0 ? opener.lead : i > bar ? "Only once their bar is confirmed (not on their checklist before then). " : "";
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

/**
 * How it could sound, for members who talk with it by voice: offered side by side in the
 * proposal, none marked as its pick, so the choice stays theirs whatever their rules on advice.
 */
function voices(): string {
  return `\n\nHow you'll sound: they can talk with you by voice, on calls, and hear your replies in voice notes. In propose_agent, also offer two or three ways you could sound as sound, each a voice (by id) from the list below with two first-person sentences on how you'd talk with them, drawn from how they like to work. Lay them side by side; don't mark one as yours or say which you'd pick. They choose one, or none and keep how you sound now. Your name isn't part of this.\nVoices (by id):\n${voiceMenu()}`;
}

/**
 * The setup skill for an agent made from `templateId` (the blank template when unknown), as said
 * on a `call` or typed, offering ways to sound when the member has `voice`.
 */
export function setupSkill(templateId: string | null | undefined, { call = false, voice = false }: { call?: boolean; voice?: boolean } = {}): WorkspaceSkill {
  const template = templateById(templateId) ?? templateById(DEFAULT_TEMPLATE_ID)!;
  const opener = call ? OPENERS.call : OPENERS.text;
  return {
    id: SETUP_SKILL_ID,
    catalogId: null,
    name: SETUP_SKILL_NAME,
    description: template.setup.intro,
    instructions: `${rules(opener).replace("{count}", String(setupSteps(template).length))}

This agent started from the "${template.name}" template.${call ? "" : ` ${template.setup.intro}`}

What setup may cover, in order (your guide, not their checklist):
${steps(template, opener)}${templateTasks(template)}${library()}${voice ? voices() : ""}`,
    createdAt: 0,
  };
}

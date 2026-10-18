import { MAX_SKILL_INSTRUCTIONS_LENGTH, MAX_SKILL_NAME_LENGTH } from "@/lib/types";

// Pure helpers shared by the server and tests.

/**
 * What the agent is sent for a message with a skill attached: the skill's instructions,
 * then the user's own words. Only this message carries them; nothing is added to other runs
 * (except the setup skill, kept in context while setup is in progress; see buildAgentContext).
 */
export function renderSkillMessage(skill: { name: string; instructions: string }, text: string): string {
  const request = text.trim();
  return [
    `Use the skill "${skill.name}" for this request.`,
    `Skill instructions:\n${skill.instructions.trim()}`,
    request ? `Request:\n${request}` : "Request: go ahead with the skill as written.",
  ].join("\n\n");
}

/** A starting point for "Save as skill": the conversation's requests, as steps. */
export function draftFromConversation(title: string, requests: string[]) {
  const steps = requests
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r, i) => `${i + 1}. ${r}`)
    .join("\n");
  return {
    name: title.slice(0, MAX_SKILL_NAME_LENGTH),
    description: "",
    instructions: steps.slice(0, MAX_SKILL_INSTRUCTIONS_LENGTH),
  };
}

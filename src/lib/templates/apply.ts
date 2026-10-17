import { addFromCatalog, listSkills } from "@/lib/skills";
import { createTask, listTasks } from "@/lib/tasks";
import type { Tenant } from "@/lib/tenant";
import { MAX_SKILLS } from "@/lib/types";
import { getSettings, updateSettings } from "@/lib/workspace";
import { templateById } from "./index";

/**
 * Applies a built-in template to the tenant's workspace: records it, fills in the agent's
 * instructions if the workspace has none, and copies in its library skills that aren't there
 * yet. It also gives the member applying it the template's
 * tasks, paused so nothing runs until they turn each on. Never overwrites anything the owner
 * wrote, and tasks are keyed by their template id, so applying twice changes nothing.
 * Owner-only (updateSettings and the skill writes check).
 */
export async function applyTemplate(
  tenant: Tenant,
  templateId: string,
  options: { timezone?: string } = {},
): Promise<{ addedSkills: number; addedTasks: number }> {
  const template = templateById(templateId);
  if (!template) throw Object.assign(new Error("That template doesn't exist."), { status: 404 });
  const settings = await getSettings(tenant);
  await updateSettings(tenant, {
    templateId: template.id,
    ...(settings.agentInstructions.trim() ? {} : { agentInstructions: template.instructions }),
  });
  const existing = await listSkills(tenant);
  const have = new Set(existing.map((s) => s.catalogId));
  let room = MAX_SKILLS - existing.length;
  let addedSkills = 0;
  for (const id of template.skills) {
    if (have.has(id) || room <= 0) continue;
    try {
      await addFromCatalog(tenant, id);
    } catch (error) {
      // Added meanwhile (another tab applying the same template), or the workspace filled up.
      if ((error as { status?: number }).status === 409) continue;
      throw error;
    }
    room -= 1;
    addedSkills += 1;
  }
  const addedTasks = await seedTasks(tenant, template.tasks, options.timezone ?? "UTC");
  return { addedSkills, addedTasks };
}

/** Creates the template's tasks the member doesn't have yet, paused. */
async function seedTasks(
  tenant: Tenant,
  tasks: NonNullable<ReturnType<typeof templateById>>["tasks"],
  timezone: string,
): Promise<number> {
  if (tasks.length === 0) return 0;
  const [mine, skills] = await Promise.all([listTasks(tenant), listSkills(tenant)]);
  const have = new Set(mine.map((t) => t.templateTaskId));
  let added = 0;
  for (const task of tasks) {
    if (have.has(task.id)) continue;
    try {
      await createTask(tenant, {
        title: task.title,
        instructions: task.instructions,
        // The workspace's copy of the skill; none if the owner removed it or it didn't fit.
        skillId: (task.skill && skills.find((s) => s.catalogId === task.skill)?.id) || null,
        schedule: task.schedule,
        timezone,
        plan: [],
        conversationId: null,
        templateTaskId: task.id,
        status: "paused",
      });
    } catch (error) {
      // Set up meanwhile by another tab, or the member is at their task limit.
      if ((error as { status?: number }).status === 409) continue;
      throw error;
    }
    added += 1;
  }
  return added;
}

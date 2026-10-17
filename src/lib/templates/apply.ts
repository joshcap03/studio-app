import { addFromCatalog, listSkills } from "@/lib/skills";
import type { Tenant } from "@/lib/tenant";
import { MAX_SKILLS } from "@/lib/types";
import { getSettings, updateSettings } from "@/lib/workspace";
import { templateById } from "./index";

/**
 * Applies a built-in template to the tenant's workspace: records it, fills in the agent's
 * instructions if the workspace has none, and copies in its library skills that aren't there
 * yet. Never overwrites anything the owner wrote, so applying twice changes nothing.
 * Owner-only (updateSettings and the skill writes check).
 */
export async function applyTemplate(tenant: Tenant, templateId: string): Promise<{ addedSkills: number }> {
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
  return { addedSkills };
}

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, parseBody } from "@/lib/api";
import { templateById } from "@/lib/templates";
import { timezoneSchema } from "@/lib/tasks/schema";
import { applyTemplate } from "@/lib/templates/apply";
import { authorizeTenant } from "@/lib/tenant";
import { getSettings } from "@/lib/workspace";

const body = z.object({
  templateId: z.string().refine((id) => templateById(id) !== undefined, "That template doesn't exist."),
  /** The browser's time zone, for the template's scheduled tasks. */
  timezone: timezoneSchema.optional().catch(undefined),
});

/** Applies a built-in template to the active workspace without overwriting anything (owner-only). */
export async function POST(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;
  try {
    const { addedSkills, addedTasks } = await applyTemplate(auth.value, input.templateId, { timezone: input.timezone });
    return NextResponse.json({ settings: await getSettings(auth.value), addedSkills, addedTasks });
  } catch (error) {
    return errorResponse(error);
  }
}

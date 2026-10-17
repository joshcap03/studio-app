import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, parseBody } from "@/lib/api";
import { templateById } from "@/lib/templates";
import { applyTemplate } from "@/lib/templates/apply";
import { authorizeTenant } from "@/lib/tenant";
import { getSettings } from "@/lib/workspace";

const body = z.object({
  templateId: z.string().refine((id) => templateById(id) !== undefined, "That template doesn't exist."),
});

/** Applies a built-in template to the active workspace without overwriting anything (owner-only). */
export async function POST(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;
  try {
    const { addedSkills } = await applyTemplate(auth.value, input.templateId);
    return NextResponse.json({ settings: await getSettings(auth.value), addedSkills });
  } catch (error) {
    return errorResponse(error);
  }
}

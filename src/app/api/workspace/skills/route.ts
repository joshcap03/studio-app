import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, noStore, parseBody } from "@/lib/api";
import { addFromCatalog, createSkill, listSkills } from "@/lib/skills";
import { createSkillBody } from "@/lib/skills/schema";
import { authorizeTenant } from "@/lib/tenant";

export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ skills: await listSkills(auth.value) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

/** Adds a library entry ({ catalogId }) or the owner's own skill. */
export async function POST(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const input = await parseBody(request, createSkillBody);
  if (input instanceof NextResponse) return input;
  try {
    const skill = "catalogId" in input ? await addFromCatalog(auth.value, input.catalogId) : await createSkill(auth.value, input);
    return NextResponse.json({ skill }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

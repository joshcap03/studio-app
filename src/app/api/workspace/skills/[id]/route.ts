import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, parseBody } from "@/lib/api";
import { deleteSkill, updateSkill } from "@/lib/skills";
import { patchSkillBody } from "@/lib/skills/schema";
import { authorizeTenant, jsonError } from "@/lib/tenant";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Skill not found.");
  const patch = await parseBody(request, patchSkillBody);
  if (patch instanceof NextResponse) return patch;
  try {
    const skill = await updateSkill(auth.value, id.data, patch);
    if (!skill) return jsonError(404, "Skill not found.");
    return NextResponse.json({ skill });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Skill not found.");
  try {
    if (!(await deleteSkill(auth.value, id.data))) return jsonError(404, "Skill not found.");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

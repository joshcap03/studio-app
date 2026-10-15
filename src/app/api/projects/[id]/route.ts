import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, noStore, parseBody } from "@/lib/api";
import { deleteProject, getProject, updateProject } from "@/lib/projects";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { MAX_CONTEXT_LENGTH, MAX_PROJECT_NAME_LENGTH } from "@/lib/types";

type Context = { params: Promise<{ id: string }> };

const patch = z
  .object({
    name: z.string().trim().min(1, "Name the project.").max(MAX_PROJECT_NAME_LENGTH).optional(),
    instructions: z.string().trim().max(MAX_CONTEXT_LENGTH).optional(),
  })
  .refine((p) => p.name !== undefined || p.instructions !== undefined, "Nothing to change.");

// A project that isn't the caller's (in their active workspace) is indistinguishable from
// one that doesn't exist: always 404.

export async function GET(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Project not found.");
  try {
    const project = await getProject(auth.value, id.data);
    if (!project) return jsonError(404, "Project not found.");
    return NextResponse.json({ project }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Project not found.");
  const input = await parseBody(request, patch);
  if (input instanceof NextResponse) return input;
  try {
    const project = await updateProject(auth.value, id.data, input);
    if (!project) return jsonError(404, "Project not found.");
    return NextResponse.json({ project });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Deletes the project with its conversations and files. */
export async function DELETE(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Project not found.");
  try {
    if (!(await deleteProject(auth.value, id.data))) return jsonError(404, "Project not found.");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

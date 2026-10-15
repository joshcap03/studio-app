import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, noStore, parseBody } from "@/lib/api";
import { createProject, listProjects } from "@/lib/projects";
import { authorizeTenant } from "@/lib/tenant";
import { MAX_CONTEXT_LENGTH, MAX_PROJECT_NAME_LENGTH } from "@/lib/types";

const body = z.object({
  name: z.string().trim().min(1, "Name the project.").max(MAX_PROJECT_NAME_LENGTH),
  instructions: z.string().trim().max(MAX_CONTEXT_LENGTH).optional(),
});

export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ projects: await listProjects(auth.value) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;
  try {
    return NextResponse.json({ project: await createProject(auth.value, input) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

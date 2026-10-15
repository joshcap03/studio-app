import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api";
import { addProjectFile } from "@/lib/projects";
import { authorizeTenant, jsonError } from "@/lib/tenant";

type Context = { params: Promise<{ id: string }> };

// Adds one file (multipart field "file") to one of the caller's projects. The agent gets it
// with every message in the project's conversations.

export async function POST(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Project not found.");
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return jsonError(400, "Choose a file to add.");
  try {
    const added = await addProjectFile(auth.value, id.data, file);
    if (!added) return jsonError(404, "Project not found.");
    return NextResponse.json({ file: added }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

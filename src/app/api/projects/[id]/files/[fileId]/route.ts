import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api";
import { removeProjectFile } from "@/lib/projects";
import { authorizeTenant, jsonError } from "@/lib/tenant";

type Context = { params: Promise<{ id: string; fileId: string }> };

export async function DELETE(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const { id, fileId } = await params;
  const ids = z.tuple([z.uuid(), z.uuid()]).safeParse([id, fileId]);
  if (!ids.success) return jsonError(404, "File not found.");
  try {
    if (!(await removeProjectFile(auth.value, ...ids.data))) return jsonError(404, "File not found.");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

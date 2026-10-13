import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api";
import { forget, memoryEnabled, parseMemoryId } from "@/lib/memory";
import { authorizeTenant, jsonError } from "@/lib/tenant";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  if (!memoryEnabled()) return jsonError(503, "Memory isn't set up for this app yet.");
  const id = decodeURIComponent((await params).id);
  if (!parseMemoryId(id)) return jsonError(404, "Memory not found.");
  try {
    if (!(await forget(auth.value, id))) return jsonError(404, "Memory not found.");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

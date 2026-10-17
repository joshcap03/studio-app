import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, noStore } from "@/lib/api";
import { getTask, listRuns } from "@/lib/tasks";
import { authorizeTenant, jsonError } from "@/lib/tenant";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Task not found.");
  try {
    if (!(await getTask(auth.value, id.data))) return jsonError(404, "Task not found.");
    return NextResponse.json({ runs: await listRuns(auth.value, id.data) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

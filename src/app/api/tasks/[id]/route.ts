import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, noStore, parseBody } from "@/lib/api";
import { deleteTask, getTask, updateTask } from "@/lib/tasks";
import { patchTaskBody } from "@/lib/tasks/schema";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { barScore, describeScore } from "@/lib/verdicts";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Task not found.");
  try {
    const task = await getTask(auth.value, id.data);
    if (!task) return jsonError(404, "Task not found.");
    // What the member kept of this task's results lately; the page shows it as a quiet line.
    const score = await barScore(auth.value, { taskId: task.id }).then(describeScore, () => null);
    return NextResponse.json({ task, score }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Task not found.");
  const patch = await parseBody(request, patchTaskBody);
  if (patch instanceof NextResponse) return patch;
  try {
    const task = await updateTask(auth.value, id.data, patch);
    if (!task) return jsonError(404, "Task not found.");
    return NextResponse.json({ task });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Task not found.");
  try {
    if (!(await deleteTask(auth.value, id.data))) return jsonError(404, "Task not found.");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

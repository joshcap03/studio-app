import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, noStore, parseBody } from "@/lib/api";
import { createTask, listTasks } from "@/lib/tasks";
import { createTaskBody } from "@/lib/tasks/schema";
import { authorizeTenant, jsonError } from "@/lib/tenant";

export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ tasks: await listTasks(auth.value) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const input = await parseBody(request, createTaskBody);
  if (input instanceof NextResponse) return input;
  try {
    return NextResponse.json({ task: await createTask(auth.value, input) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

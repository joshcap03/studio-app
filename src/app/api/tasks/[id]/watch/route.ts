import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, noStore, parseBody } from "@/lib/api";
import { previewEnabled } from "@/lib/flags";
import { getTask } from "@/lib/tasks";
import { getWatch, unwatchTask, watchBody, watchTask } from "@/lib/tasks/watches";
import { authorizeTenant, jsonError } from "@/lib/tenant";

// What one of the member's tasks watches for (docs/watches.md): GET reads it, PUT sets it
// (starting Composio's trigger under their own id), DELETE stops watching. The "watches" preview.

type Context = { params: Promise<{ id: string }> };

async function authorize(request: NextRequest, params: Context["params"]) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth;
  if (!previewEnabled(auth.value, "watches")) return { ok: false as const, response: jsonError(404, "Not found.") };
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return { ok: false as const, response: jsonError(404, "Task not found.") };
  return { ok: true as const, tenant: auth.value, id: id.data };
}

export async function GET(request: NextRequest, { params }: Context) {
  const auth = await authorize(request, params);
  if (!auth.ok) return auth.response;
  try {
    if (!(await getTask(auth.tenant, auth.id))) return jsonError(404, "Task not found.");
    return NextResponse.json({ watch: await getWatch(auth.tenant, auth.id) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: Context) {
  const auth = await authorize(request, params);
  if (!auth.ok) return auth.response;
  const draft = await parseBody(request, watchBody);
  if (draft instanceof NextResponse) return draft;
  try {
    const task = await getTask(auth.tenant, auth.id);
    if (!task) return jsonError(404, "Task not found.");
    return NextResponse.json({ watch: await watchTask(auth.tenant, task, draft) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  const auth = await authorize(request, params);
  if (!auth.ok) return auth.response;
  try {
    if (!(await unwatchTask(auth.tenant, auth.id))) return jsonError(404, "This task isn't watching anything.");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

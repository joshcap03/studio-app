import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, parseBody } from "@/lib/api";
import { deleteRecord, updateRecord } from "@/lib/tasks/records";
import { patchRecordBody } from "@/lib/tasks/schema";
import { authorizeTenant, jsonError } from "@/lib/tenant";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Record not found.");
  const patch = await parseBody(request, patchRecordBody);
  if (patch instanceof NextResponse) return patch;
  try {
    const record = await updateRecord(auth.value, id.data, patch);
    if (!record) return jsonError(404, "Record not found.");
    return NextResponse.json({ record });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Record not found.");
  try {
    if (!(await deleteRecord(auth.value, id.data))) return jsonError(404, "Record not found.");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, parseBody } from "@/lib/api";
import { patchItemBody, removeLibraryItem, updateLibraryItem } from "@/lib/library";
import { authorizeTenant, jsonError } from "@/lib/tenant";

type Context = { params: Promise<{ id: string }> };

/** Renames or pins an item. */
export async function PATCH(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Not in your Library.");
  const patch = await parseBody(request, patchItemBody);
  if (patch instanceof NextResponse) return patch;
  try {
    const item = await updateLibraryItem(auth.value, id.data, patch);
    if (!item) return jsonError(404, "Not in your Library.");
    return NextResponse.json({ item });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Takes an item out of the Library; the doc itself stays wherever it lives. */
export async function DELETE(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Not in your Library.");
  try {
    if (!(await removeLibraryItem(auth.value, id.data))) return jsonError(404, "Not in your Library.");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

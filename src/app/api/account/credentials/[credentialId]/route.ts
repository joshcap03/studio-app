import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api";
import { deleteCredential } from "@/lib/secrets";
import { authorizeSession, jsonError } from "@/lib/tenant";

type Context = { params: Promise<{ credentialId: string }> };

/** Removes one of the caller's saved logins or cards, and its secret. */
export async function DELETE(request: NextRequest, { params }: Context) {
  const auth = await authorizeSession(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).credentialId);
  if (!id.success) return jsonError(404, "That wasn't found.");
  try {
    if (!(await deleteCredential(auth.value, id.data))) return jsonError(404, "That wasn't found.");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

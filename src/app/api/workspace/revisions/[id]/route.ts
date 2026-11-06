import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api";
import { previewEnabled } from "@/lib/flags";
import { restoreRevision } from "@/lib/revisions";
import { authorizeTenant, jsonError } from "@/lib/tenant";

type Context = { params: Promise<{ id: string }> };

/** Puts a part of the agent back as this revision had it. */
export async function POST(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  if (!previewEnabled(auth.value, "studio")) return jsonError(404, "Not found.");
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Revision not found.");
  try {
    if (!(await restoreRevision(auth.value, id.data))) return jsonError(404, "Revision not found.");
    return NextResponse.json({ restored: true });
  } catch (error) {
    return errorResponse(error);
  }
}

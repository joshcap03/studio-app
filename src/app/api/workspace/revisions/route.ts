import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, noStore } from "@/lib/api";
import { previewEnabled } from "@/lib/flags";
import { listRevisions } from "@/lib/revisions";
import { authorizeTenant, jsonError } from "@/lib/tenant";

/** What this agent's brief and skills were before each change (the "studio" preview). */
export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  if (!previewEnabled(auth.value, "studio")) return jsonError(404, "Not found.");
  try {
    return NextResponse.json({ revisions: await listRevisions(auth.value) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

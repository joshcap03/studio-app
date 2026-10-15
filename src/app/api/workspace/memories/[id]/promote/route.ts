import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api";
import { requestPromotion } from "@/lib/brain";
import { previewEnabled } from "@/lib/flags";
import { memoryEnabled, parseMemoryId } from "@/lib/memory";
import { authorizeTenant, jsonError } from "@/lib/tenant";

/** Asks for one of the caller's personal memories to be shared with the workspace. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  if (!previewEnabled(auth.value, "brain")) return jsonError(404, "Not found.");
  if (!memoryEnabled()) return jsonError(503, "Memory isn't set up for this app yet.");
  const id = decodeURIComponent((await params).id);
  if (!parseMemoryId(id)) return jsonError(404, "Memory not found.");
  try {
    return NextResponse.json({ promotion: await requestPromotion(auth.value, id) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

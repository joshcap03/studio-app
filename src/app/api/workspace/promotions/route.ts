import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, noStore } from "@/lib/api";
import { listPromotions } from "@/lib/brain";
import { previewEnabled } from "@/lib/flags";
import { authorizeTenant, jsonError } from "@/lib/tenant";

/** Pending shares: the caller's own, plus everyone's for an owner. */
export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  if (!previewEnabled(auth.value, "brain")) return jsonError(404, "Not found.");
  try {
    return NextResponse.json({ promotions: await listPromotions(auth.value) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

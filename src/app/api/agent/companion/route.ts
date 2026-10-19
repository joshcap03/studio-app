import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api";
import { getCompanion } from "@/lib/companion";
import { previewEnabled } from "@/lib/flags";
import { authorizeTenant } from "@/lib/tenant";

/** Who the agent the member is in is to them (null where it isn't shown), as it moves along. */
export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  if (!previewEnabled(auth.value, "companion")) return NextResponse.json({ companion: null });
  try {
    return NextResponse.json({ companion: await getCompanion(auth.value) });
  } catch (error) {
    return errorResponse(error);
  }
}

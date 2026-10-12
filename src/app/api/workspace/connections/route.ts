import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, noStore } from "@/lib/api";
import { listConnections } from "@/lib/integrations/composio";
import { authorizeTenant } from "@/lib/tenant";

/** The caller's own connected apps in the active workspace. */
export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json(await listConnections(auth.value.composioUserId), noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

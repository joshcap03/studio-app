import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, noStore } from "@/lib/api";
import { authorizeTenant } from "@/lib/tenant";
import { getUsage } from "@/lib/workspace";

export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ usage: await getUsage(auth.value) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

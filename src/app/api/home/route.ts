import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, noStore } from "@/lib/api";
import { loadHome } from "@/lib/home";
import { authorizeTenant } from "@/lib/tenant";

/** Home across the member's agents: their latest chats from every agent on Home, with whose move it is in each. */
export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json(await loadHome(auth.value), noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, noStore } from "@/lib/api";
import { storeFor } from "@/lib/chat/store-for";
import { authorizeTenant } from "@/lib/tenant";

export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const query = request.nextUrl.searchParams.get("q")?.slice(0, 200) ?? "";
  try {
    return NextResponse.json({ conversations: await storeFor(auth.value).listConversations(query) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

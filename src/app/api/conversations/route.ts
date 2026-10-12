import { NextResponse, type NextRequest } from "next/server";
import { authorize } from "@/lib/auth/server";
import { getStore } from "@/lib/db/store";

export async function GET(request: NextRequest) {
  const auth = await authorize(request);
  if (!auth.ok) return auth.response;
  const query = request.nextUrl.searchParams.get("q")?.slice(0, 200) ?? "";
  const conversations = getStore().listConversations(auth.userId, query);
  return NextResponse.json({ conversations }, { headers: { "Cache-Control": "no-store" } });
}

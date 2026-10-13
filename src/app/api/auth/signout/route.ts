import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ACTIVE_WORKSPACE_COOKIE, isSameOrigin, jsonError } from "@/lib/tenant";

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return jsonError(403, "Cross-origin request refused.");
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(ACTIVE_WORKSPACE_COOKIE);
  return response;
}

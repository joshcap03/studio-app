import { NextResponse, type NextRequest } from "next/server";
import { noStore } from "@/lib/api";
import { CATALOG } from "@/lib/skills/catalog";
import { authorizeTenant } from "@/lib/tenant";

export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ catalog: CATALOG }, noStore);
}

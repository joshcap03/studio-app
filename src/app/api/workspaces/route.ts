import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, noStore, parseBody } from "@/lib/api";
import { ACTIVE_WORKSPACE_COOKIE, authorizeSession, jsonError, resolveTenant } from "@/lib/tenant";
import { MAX_CONTEXT_LENGTH } from "@/lib/types";

const create = z.object({
  name: z.string().trim().min(1, "Name your workspace.").max(80),
  businessContext: z.string().trim().max(MAX_CONTEXT_LENGTH).default(""),
});

export async function GET(request: NextRequest) {
  const auth = await authorizeSession(request);
  if (!auth.ok) return auth.response;
  const tenant = await resolveTenant(auth.value, request.cookies.get(ACTIVE_WORKSPACE_COOKIE)?.value);
  return NextResponse.json({ workspaces: tenant?.workspaces ?? [], active: tenant?.workspace.id ?? null }, noStore);
}

export async function POST(request: NextRequest) {
  const auth = await authorizeSession(request);
  if (!auth.ok) return auth.response;
  const input = await parseBody(request, create);
  if (input instanceof NextResponse) return input;
  try {
    const { data, error } = await auth.value.db.rpc("create_workspace", {
      p_name: input.name,
      p_business_context: input.businessContext,
    });
    if (error) {
      if (error.hint === "workspace_limit") return jsonError(409, "You've reached the limit of 3 workspaces.");
      throw error;
    }
    const response = NextResponse.json({ workspaceId: data as string }, { status: 201 });
    response.cookies.set(ACTIVE_WORKSPACE_COOKIE, data as string, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

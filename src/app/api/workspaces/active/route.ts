import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseBody } from "@/lib/api";
import { ACTIVE_WORKSPACE_COOKIE, authorizeSession, jsonError, resolveTenant } from "@/lib/tenant";

const body = z.object({ workspaceId: z.uuid() });

/** Switch the active workspace. Only workspaces the caller belongs to are accepted. */
export async function POST(request: NextRequest) {
  const auth = await authorizeSession(request);
  if (!auth.ok) return auth.response;
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;
  const tenant = await resolveTenant(auth.value, input.workspaceId);
  if (!tenant || tenant.workspace.id !== input.workspaceId) return jsonError(404, "Agent not found.");
  const response = NextResponse.json({ workspace: tenant.workspace });
  response.cookies.set(ACTIVE_WORKSPACE_COOKIE, tenant.workspace.id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  return response;
}

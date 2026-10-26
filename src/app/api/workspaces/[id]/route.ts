import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api";
import { deleteAgent } from "@/lib/delete-agent";
import { ACTIVE_WORKSPACE_COOKIE, authorizeSession, jsonError, resolveTenant } from "@/lib/tenant";

type Context = { params: Promise<{ id: string }> };

/**
 * Deletes one of the caller's agents, with its chats, tasks, skills, files, and memory. Only an
 * agent they own (checked against their memberships), never one named by the tab or cookie.
 */
export async function DELETE(request: NextRequest, { params }: Context) {
  const auth = await authorizeSession(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Agent not found.");
  try {
    const tenant = await resolveTenant(auth.value, id.data);
    if (!tenant || tenant.workspace.id !== id.data) return jsonError(404, "Agent not found.");
    await deleteAgent(tenant);
    // The agent the browser opens next: the one it had, unless that was this one.
    const preferred = request.cookies.get(ACTIVE_WORKSPACE_COOKIE)?.value;
    const next = await resolveTenant(auth.value, preferred === id.data ? null : preferred);
    const response = NextResponse.json({ next: next?.workspace.id ?? null });
    if (next) response.cookies.set(ACTIVE_WORKSPACE_COOKIE, next.workspace.id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
    else response.cookies.delete(ACTIVE_WORKSPACE_COOKIE);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

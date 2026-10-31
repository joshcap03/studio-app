import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api";
import { createConnectLink, disconnect } from "@/lib/integrations/composio";
import { authorizeTenant, jsonError } from "@/lib/tenant";

type Context = { params: Promise<{ toolkit: string }> };
const slug = z.string().regex(/^[a-z0-9_]{1,64}$/);
// Where the member comes back to after the provider: Settings, or the agent's own page in Studio.
const returnTo = z.enum(["/settings", "/studio"]).catch("/settings");

/** Start connecting an app for the caller. Returns the provider's authorization URL. */
export async function POST(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const toolkit = slug.safeParse((await params).toolkit);
  if (!toolkit.success) return jsonError(404, "Unknown app.");
  const back = returnTo.parse(request.nextUrl.searchParams.get("return"));
  try {
    const callback = new URL(back, request.nextUrl.origin);
    callback.searchParams.set("connected", toolkit.data);
    const url = await createConnectLink(auth.value.composioUserId, toolkit.data, callback.toString());
    return NextResponse.json({ url });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const toolkit = slug.safeParse((await params).toolkit);
  if (!toolkit.success) return jsonError(404, "Unknown app.");
  try {
    if (!(await disconnect(auth.value.composioUserId, toolkit.data))) return jsonError(404, "Not connected.");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

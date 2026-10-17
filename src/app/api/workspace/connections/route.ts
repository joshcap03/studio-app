import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, noStore } from "@/lib/api";
import { toolkitForApp } from "@/lib/apps";
import { listConnections } from "@/lib/integrations/composio";
import { templateById } from "@/lib/templates";
import { authorizeTenant } from "@/lib/tenant";
import { getSettings } from "@/lib/workspace";

/** The caller's own connected apps in the active workspace, plus the ones its template suggests. */
export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  try {
    const template = templateById((await getSettings(auth.value)).templateId);
    const suggested = [...(template?.apps ?? []), ...(template?.optionalApps ?? [])]
      .map(toolkitForApp)
      .filter((slug): slug is string => Boolean(slug));
    return NextResponse.json(await listConnections(auth.value.composioUserId, suggested), noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, noStore } from "@/lib/api";
import { browserControl } from "@/lib/browser-view";
import { authorizeTenant, jsonError } from "@/lib/tenant";

// Taking over the agent's browser in one of the caller's conversations: a live view of the page
// it's on that they can click and type in (to sign in, say), good for a few minutes. Asked for
// only on their tap (a POST, so another site can't), returned to them alone and never stored or
// cached. The agent never sees it, and the browser's connection stays on the server.

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const ids = z.object({ id: z.uuid() }).safeParse(await params);
  if (!ids.success) return jsonError(404, "Not found.");
  try {
    const control = await browserControl(auth.value, ids.data.id);
    if (!control.ok) {
      if (control.reason === "off") return jsonError(404, "Not found.");
      if (control.reason === "failed") return jsonError(503, "Couldn't reach the browser just now. Try again.", "browser_unavailable");
      return jsonError(404, "The browser has closed. Ask me to open the page again.", control.reason === "ended" ? "browser_ended" : "browser_none");
    }
    return NextResponse.json({ url: control.url }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

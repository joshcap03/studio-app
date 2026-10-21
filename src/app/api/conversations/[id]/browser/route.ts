import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api";
import { browserFrame } from "@/lib/browser-view";
import { authorizeTenant, jsonError } from "@/lib/tenant";

// A picture of what the agent's browser shows in one of the caller's conversations, for watching
// it on a call or taking it over: taken now, server-side, and never stored or cached. Only
// pictures leave here; the browser's connection stays on the server. Each one reaches the hosted
// browser, so another site can't ask for them.

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request, { writes: true });
  if (!auth.ok) return auth.response;
  const ids = z.object({ id: z.uuid() }).safeParse(await params);
  if (!ids.success) return jsonError(404, "Not found.");
  try {
    const frame = await browserFrame(auth.value, ids.data.id);
    if (!frame.ok) {
      if (frame.reason === "failed") return jsonError(503, "Couldn't see the browser just now.", "browser_unavailable");
      return jsonError(404, frame.reason === "ended" ? "The browser has closed." : "No browser open.", frame.reason === "ended" ? "browser_ended" : "browser_none");
    }
    return new NextResponse(new Blob([frame.jpeg as BlobPart], { type: "image/jpeg" }), {
      headers: { "Content-Type": "image/jpeg", "Content-Length": String(frame.jpeg.byteLength), "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

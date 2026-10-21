import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseBody } from "@/lib/api";
import { DRIVE_KEYS, driveBrowser } from "@/lib/browser-fill";
import { authorizeTenant, jsonError } from "@/lib/tenant";

// Taking over the agent's browser in one of the caller's conversations: each click, key, scroll,
// or bit of typing on the picture is passed to the browser server-side. The browser's connection
// never leaves the server, and what the member types is never logged or kept (it may be a
// password or a 2FA code).

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const fraction = z.number().min(0).max(1);
const body = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("click"), x: fraction, y: fraction }),
  z.strictObject({ type: z.literal("text"), text: z.string().min(1).max(500) }),
  z.strictObject({ type: z.literal("key"), key: z.enum(DRIVE_KEYS) }),
  z.strictObject({ type: z.literal("scroll"), x: fraction, y: fraction, dy: z.number().min(-2000).max(2000) }),
]);

export async function POST(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Not found.");
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;
  try {
    const done = await driveBrowser(auth.value, id.data, input);
    if (done.ok) return NextResponse.json({ ok: true });
    if (done.reason === "failed") return jsonError(503, "Couldn't reach the browser just now.", "browser_unavailable");
    if (done.reason === "off") return jsonError(404, "Not found.");
    return jsonError(409, done.reason === "ended" ? "The browser has closed." : "No browser open.", done.reason === "ended" ? "browser_ended" : "browser_none");
  } catch {
    console.error("[browser] couldn't pass input on");
    return jsonError(500, "Something went wrong. Try again.");
  }
}

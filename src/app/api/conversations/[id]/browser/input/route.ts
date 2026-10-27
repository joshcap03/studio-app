import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseBody } from "@/lib/api";
import { driveBrowser } from "@/lib/browser-fill";
import { DRIVE_KEYS } from "@/lib/types";
import { authorizeTenant, jsonError } from "@/lib/tenant";

// Taking over the agent's browser in one of the caller's conversations: each click, key, scroll,
// or bit of typing on the picture is passed to the browser server-side. The browser's connection
// never leaves the server, and what the member types is never logged or kept (it may be a
// password or a 2FA code). While they show the agent a job ("Show me once", `record`), each input
// comes back as the step it was, for the card to keep: what it was done to, and what was typed
// only where the field isn't a password, card, or code.

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const fraction = z.number().min(0).max(1);
const record = z.boolean().optional();
const body = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("click"), x: fraction, y: fraction, record }),
  z.strictObject({ type: z.literal("text"), text: z.string().min(1).max(500), record }),
  z.strictObject({ type: z.literal("key"), key: z.enum(DRIVE_KEYS), record }),
  z.strictObject({ type: z.literal("scroll"), x: fraction, y: fraction, dy: z.number().min(-2000).max(2000), record }),
  z.strictObject({ type: z.literal("look"), record: z.literal(true) }),
]);

export async function POST(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Not found.");
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;
  try {
    const { record: recording, ...rest } = input;
    const done = await driveBrowser(auth.value, id.data, rest, { record: recording === true });
    if (done.ok) return NextResponse.json({ ok: true, ...(done.step ? { step: done.step } : {}) });
    if (done.reason === "failed") return jsonError(503, "Couldn't reach the browser just now.", "browser_unavailable");
    if (done.reason === "off") return jsonError(404, "Not found.");
    return jsonError(409, done.reason === "ended" ? "The browser has closed." : "No browser open.", done.reason === "ended" ? "browser_ended" : "browser_none");
  } catch {
    console.error("[browser] couldn't pass input on");
    return jsonError(500, "Something went wrong. Try again.");
  }
}

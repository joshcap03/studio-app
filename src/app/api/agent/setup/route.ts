import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, parseBody } from "@/lib/api";
import { updateSetup } from "@/lib/setup-state";
import { authorizeTenant, jsonError } from "@/lib/tenant";

const body = z.strictObject({ status: z.literal("skipped") });

/** The owner set the agent's setup aside ("Not now"); they can start it again from the agent's page. */
export async function POST(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;
  try {
    if (!(await updateSetup(auth.value, { status: input.status }))) return jsonError(403, "Only the owner can change this agent's setup.");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

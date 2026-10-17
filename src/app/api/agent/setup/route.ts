import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, parseBody } from "@/lib/api";
import { summarizeSetup, updateSetup } from "@/lib/setup-state";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { getSettings } from "@/lib/workspace";

const body = z.strictObject({ status: z.literal("skipped") });

/** Where the owner's setup stands (null for other members), for the journey rail as it moves. */
export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  try {
    const settings = await getSettings(auth.value);
    return NextResponse.json({ setup: summarizeSetup(auth.value, settings.setup, settings.templateId) });
  } catch (error) {
    return errorResponse(error);
  }
}

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

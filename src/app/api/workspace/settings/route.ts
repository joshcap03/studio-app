import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, noStore, parseBody } from "@/lib/api";
import { authorizeTenant } from "@/lib/tenant";
import { MAX_CONTEXT_LENGTH } from "@/lib/types";
import { getSettings, updateSettings } from "@/lib/workspace";

const patch = z.object({
  name: z.string().trim().min(1, "Name this agent.").max(80).optional(),
  profile: z.string().trim().max(MAX_CONTEXT_LENGTH).optional(),
  agentInstructions: z.string().trim().max(MAX_CONTEXT_LENGTH).optional(),
});

export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ settings: await getSettings(auth.value), role: auth.value.workspace.role }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const input = await parseBody(request, patch);
  if (input instanceof NextResponse) return input;
  try {
    return NextResponse.json({ settings: await updateSettings(auth.value, input) });
  } catch (error) {
    return errorResponse(error);
  }
}

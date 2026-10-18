import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, noStore } from "@/lib/api";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { endVoiceCall } from "@/lib/voice";

// Ends one of the member's calls and records how long it ran, at the server's clock. A call
// that isn't theirs, or is already over, is not found.

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Call not found.");
  try {
    const seconds = await endVoiceCall(auth.value, id.data);
    if (seconds === null) return jsonError(404, "Call not found.");
    return NextResponse.json({ seconds }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

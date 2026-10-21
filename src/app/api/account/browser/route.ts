import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, noStore } from "@/lib/api";
import { forgetSignIns, hasSignIns } from "@/lib/browser-signins";
import { authorizeSession } from "@/lib/tenant";

// The caller's saved sign-ins for the agent's browser, shared by all their agents: whether they
// have any, and forgetting them. Only that they exist is known here; what they hold stays at
// Browserbase.

export async function GET(request: NextRequest) {
  const auth = await authorizeSession(request);
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ saved: await hasSignIns(auth.value) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await authorizeSession(request);
  if (!auth.ok) return auth.response;
  try {
    await forgetSignIns(auth.value);
    return NextResponse.json({ saved: (await hasSignIns(auth.value)) === null ? null : false }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

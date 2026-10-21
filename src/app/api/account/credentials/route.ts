import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, noStore } from "@/lib/api";
import { credentialsEnabled, listCredentials } from "@/lib/secrets";
import { authorizeSession } from "@/lib/tenant";

// The logins and cards the caller saved for their agents' browser: what's shown of them, never
// their secrets. Saving happens only on the secure fill card (src/app/api/conversations/[id]/secrets).

export async function GET(request: NextRequest) {
  const auth = await authorizeSession(request);
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ credentials: await listCredentials(auth.value), enabled: credentialsEnabled() }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

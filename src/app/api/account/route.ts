import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAccount, MAX_ACCOUNT_ABOUT, MAX_ACCOUNT_NAME, updateAccount } from "@/lib/account";
import { errorResponse, noStore, parseBody } from "@/lib/api";
import { authorizeSession } from "@/lib/tenant";

// The caller's own profile, shared by all their agents. Needs no agent yet: onboarding asks
// for it first.

const patch = z.object({
  name: z.string().trim().max(MAX_ACCOUNT_NAME, "Keep your name under 80 characters.").optional(),
  about: z.string().trim().max(MAX_ACCOUNT_ABOUT, "Keep this under 4,000 characters.").optional(),
});

export async function GET(request: NextRequest) {
  const auth = await authorizeSession(request);
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ account: await getAccount(auth.value) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await authorizeSession(request);
  if (!auth.ok) return auth.response;
  const input = await parseBody(request, patch);
  if (input instanceof NextResponse) return input;
  try {
    return NextResponse.json({ account: await updateAccount(auth.value, input) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

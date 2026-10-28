import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAllowedActions, setAllowedAction } from "@/lib/account";
import { errorResponse, noStore, parseBody } from "@/lib/api";
import { isStandingKind, type StandingKind } from "@/lib/approvals/standing";
import { authorizeSession } from "@/lib/tenant";

// The kinds of change the caller has OK'd for good, for all their agents
// (src/lib/approvals/standing.ts), and taking one back. One is given only by their tap on a
// request of that kind (the messages route: the first approval of a kind), never here.

const patch = z.strictObject({ disallow: z.string().refine((k): k is StandingKind => isStandingKind(k), "Unknown kind.") });

export async function GET(request: NextRequest) {
  const auth = await authorizeSession(request);
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ allowed: await getAllowedActions(auth.value) }, noStore);
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
    return NextResponse.json({ allowed: await setAllowedAction(auth.value, input.disallow, false) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

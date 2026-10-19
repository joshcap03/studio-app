import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, noStore, parseBody } from "@/lib/api";
import { addLink, addLinkBody, listLibrary } from "@/lib/library";
import { authorizeTenant } from "@/lib/tenant";

/** The member's Library for the active agent: what it made and links they filed. */
export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ items: await listLibrary(auth.value) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

/** Files a link the member pastes, e.g. a Google Doc they already keep. */
export async function POST(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const body = await parseBody(request, addLinkBody);
  if (body instanceof NextResponse) return body;
  try {
    return NextResponse.json({ item: await addLink(auth.value, body) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

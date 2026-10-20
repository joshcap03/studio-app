import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, noStore } from "@/lib/api";
import { marksOf } from "@/lib/chat/move";
import { storeFor } from "@/lib/chat/store-for";
import { MAX_MOVES } from "@/lib/db/store";
import { authorizeTenant, jsonError } from "@/lib/tenant";

// Whose move it is in the caller's conversations, for the sidebar's marks: working, their call,
// or stuck (src/lib/chat/move.ts); done and idle ones are left out. `ids` names the conversations
// (the most recent ones in the sidebar). Ids that aren't the caller's in this agent are left out,
// as if they had nothing to show.

const ids = z.array(z.uuid()).max(MAX_MOVES);

export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const parsed = ids.safeParse((request.nextUrl.searchParams.get("ids") ?? "").split(",").filter(Boolean));
  if (!parsed.success) return jsonError(400, `Ask about up to ${MAX_MOVES} conversations at a time.`);
  try {
    return NextResponse.json({ moves: marksOf(await storeFor(auth.value).lastMessages(parsed.data)) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

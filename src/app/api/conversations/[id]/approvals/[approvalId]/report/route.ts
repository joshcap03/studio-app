import type { NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { reportSpokenApproval } from "@/lib/voice/approvals";

// "That's not what I said": the member reports that one of their requests approved by voice
// wasn't what they said. That turns spoken approval off for everyone until it's cleared with SQL
// (docs/voice.md), so the next calls say approvals are taps. Only their own spoken approval in
// one of their conversations can be reported.

type Context = { params: Promise<{ id: string; approvalId: string }> };

export async function POST(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const ids = z.object({ id: z.uuid(), approvalId: z.uuid() }).safeParse(await params);
  if (!ids.success) return jsonError(404, "Request not found.");
  try {
    const reported = await reportSpokenApproval(auth.value, ids.data.id, ids.data.approvalId);
    if (!reported) return jsonError(404, "Request not found.");
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

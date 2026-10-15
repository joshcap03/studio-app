import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, parseBody } from "@/lib/api";
import { decidePromotion } from "@/lib/brain";
import { previewEnabled } from "@/lib/flags";
import { memoryEnabled } from "@/lib/memory";
import { authorizeTenant, jsonError } from "@/lib/tenant";

const body = z.object({ decision: z.enum(["approve", "reject"]) });

/** An owner approves or rejects a member's request to share a memory. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  if (!previewEnabled(auth.value, "brain")) return jsonError(404, "Not found.");
  if (!memoryEnabled()) return jsonError(503, "Memory isn't set up for this app yet.");
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return jsonError(404, "Request not found.");
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;
  try {
    return NextResponse.json({ promotion: await decidePromotion(auth.value, id.data, input.decision) });
  } catch (error) {
    return errorResponse(error);
  }
}

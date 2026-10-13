import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, noStore, parseBody } from "@/lib/api";
import { listMemories, memoryEnabled, remember } from "@/lib/memory";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { MAX_MEMORY_LENGTH } from "@/lib/types";

const create = z.object({
  content: z.string().trim().min(1, "Write something to remember.").max(MAX_MEMORY_LENGTH),
  scope: z.enum(["workspace", "personal"]).default("workspace"),
});

export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  if (!memoryEnabled()) return jsonError(503, "Memory isn't set up for this app yet.");
  try {
    return NextResponse.json({ memories: await listMemories(auth.value) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  if (!memoryEnabled()) return jsonError(503, "Memory isn't set up for this app yet.");
  const input = await parseBody(request, create);
  if (input instanceof NextResponse) return input;
  try {
    return NextResponse.json({ memory: await remember(auth.value, input.content, input.scope) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

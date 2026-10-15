import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, noStore, parseBody } from "@/lib/api";
import { brainMemories } from "@/lib/brain";
import { previewEnabled } from "@/lib/flags";
import { listMemories, memoryEnabled, remember } from "@/lib/memory";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { MAX_MEMORY_LENGTH, MEMORY_CATEGORIES } from "@/lib/types";

const create = z.object({
  content: z.string().trim().min(1, "Write something to remember.").max(MAX_MEMORY_LENGTH),
  scope: z.enum(["workspace", "personal"]).default("workspace"),
  category: z.enum(MEMORY_CATEGORIES).optional(),
});

export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  if (!memoryEnabled()) return jsonError(503, "Memory isn't set up for this app yet.");
  try {
    const memories = previewEnabled(auth.value, "brain") ? await brainMemories(auth.value) : await listMemories(auth.value);
    return NextResponse.json({ memories }, noStore);
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
    return NextResponse.json({ memory: await remember(auth.value, input.content, input.scope, { category: input.category }) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

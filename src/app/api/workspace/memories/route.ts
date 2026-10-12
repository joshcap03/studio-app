import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, noStore, parseBody } from "@/lib/api";
import { authorizeTenant } from "@/lib/tenant";
import { MAX_MEMORY_LENGTH } from "@/lib/types";
import { addMemory, listMemories } from "@/lib/workspace";

const create = z.object({
  content: z.string().trim().min(1, "Write something to remember.").max(MAX_MEMORY_LENGTH),
  scope: z.enum(["workspace", "personal"]).default("workspace"),
});

export async function GET(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ memories: await listMemories(auth.value) }, noStore);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  const input = await parseBody(request, create);
  if (input instanceof NextResponse) return input;
  try {
    return NextResponse.json({ memory: await addMemory(auth.value, input.content, input.scope) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

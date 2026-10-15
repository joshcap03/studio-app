import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, parseBody } from "@/lib/api";
import { previewEnabled } from "@/lib/flags";
import { forget, memoryEnabled, parseMemoryId, replaceMemory } from "@/lib/memory";
import { authorizeTenant, jsonError } from "@/lib/tenant";
import { MAX_MEMORY_LENGTH, MEMORY_CATEGORIES } from "@/lib/types";

type Context = { params: Promise<{ id: string }> };

const change = z
  .object({
    content: z.string().trim().min(1, "Write something to remember.").max(MAX_MEMORY_LENGTH).optional(),
    category: z.enum(MEMORY_CATEGORIES).optional(),
    pinned: z.boolean().optional(),
  })
  .refine((c) => c.content !== undefined || c.category !== undefined || c.pinned !== undefined, "Nothing to change.");

/** Business Brain: edit, recategorize, or pin a memory. */
export async function PATCH(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  if (!previewEnabled(auth.value, "brain")) return jsonError(404, "Not found.");
  if (!memoryEnabled()) return jsonError(503, "Memory isn't set up for this app yet.");
  const id = decodeURIComponent((await params).id);
  if (!parseMemoryId(id)) return jsonError(404, "Memory not found.");
  const input = await parseBody(request, change);
  if (input instanceof NextResponse) return input;
  try {
    const memory = await replaceMemory(auth.value, id, input);
    if (!memory) return jsonError(404, "Memory not found.");
    return NextResponse.json({ memory });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  const auth = await authorizeTenant(request);
  if (!auth.ok) return auth.response;
  if (!memoryEnabled()) return jsonError(503, "Memory isn't set up for this app yet.");
  const id = decodeURIComponent((await params).id);
  if (!parseMemoryId(id)) return jsonError(404, "Memory not found.");
  try {
    if (!(await forget(auth.value, id))) return jsonError(404, "Memory not found.");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

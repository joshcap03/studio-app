import { NextResponse } from "next/server";
import type { z } from "zod";
import { jsonError } from "@/lib/tenant";

// Small helpers shared by route handlers.

export async function parseBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T> | NextResponse> {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid request.");
  return parsed.data;
}

export const noStore = { headers: { "Cache-Control": "no-store" } };

/** Maps thrown errors to safe responses; unexpected errors are logged, not echoed. */
export function errorResponse(error: unknown): NextResponse {
  const status = (error as { status?: number })?.status;
  if (status && status >= 400 && status < 500) return jsonError(status, (error as Error).message);
  console.error("[api]", error);
  return jsonError(500, "Something went wrong. Try again.");
}

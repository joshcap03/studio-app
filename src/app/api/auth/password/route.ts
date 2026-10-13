import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseBody } from "@/lib/api";
import { authorizeSession, jsonError } from "@/lib/tenant";

const body = z.object({ password: z.string().min(10, "Use at least 10 characters.").max(200) });

// Sets a new password for the signed-in user (after following a reset link).
export async function POST(request: NextRequest) {
  const auth = await authorizeSession(request);
  if (!auth.ok) return auth.response;
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;
  const { error } = await auth.value.db.auth.updateUser({ password: input.password });
  if (error) {
    if (error.code === "weak_password") return jsonError(400, "Choose a stronger password.");
    if (error.code === "same_password") return jsonError(400, "Choose a password you haven't used here before.");
    return jsonError(400, "Couldn't change the password. Request a new reset link and try again.");
  }
  return NextResponse.json({ ok: true });
}

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseBody } from "@/lib/api";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isSameOrigin, jsonError } from "@/lib/tenant";

const body = z.object({ email: z.email("Enter a valid email.") });

// Sends a password reset link. Answers the same whether or not the account exists.
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return jsonError(403, "Cross-origin request refused.");
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;
  const supabase = await createSupabaseServerClient();
  const redirectTo = new URL("/auth/confirm?next=/reset-password", request.nextUrl.origin).toString();
  const { error } = await supabase.auth.resetPasswordForEmail(input.email, { redirectTo });
  if (error?.status === 429) return jsonError(429, "Too many requests. Try again in a few minutes.");
  return NextResponse.json({ ok: true });
}

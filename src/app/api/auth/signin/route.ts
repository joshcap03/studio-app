import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseBody } from "@/lib/api";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isSameOrigin, jsonError } from "@/lib/tenant";

const body = z.object({ email: z.email("Enter a valid email."), password: z.string().min(1, "Enter your password.").max(200) });

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return jsonError(403, "Cross-origin request refused.");
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(input);
  if (error) {
    if (error.status === 429) return jsonError(429, "Too many attempts. Try again in a few minutes.");
    return jsonError(401, error.code === "email_not_confirmed" ? "Confirm your email first; check your inbox." : "That email and password don't match.");
  }
  return NextResponse.json({ ok: true });
}

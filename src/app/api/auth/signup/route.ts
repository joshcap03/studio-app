import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseBody } from "@/lib/api";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isSameOrigin, jsonError } from "@/lib/tenant";

const body = z.object({
  email: z.email("Enter a valid email."),
  password: z.string().min(10, "Use at least 10 characters.").max(200),
});

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return jsonError(403, "Cross-origin request refused.");
  const input = await parseBody(request, body);
  if (input instanceof NextResponse) return input;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    ...input,
    options: { emailRedirectTo: new URL("/auth/confirm", request.nextUrl.origin).toString() },
  });
  if (error) {
    if (error.status === 429) return jsonError(429, "Too many sign-ups from here. Try again later.");
    if (error.code === "weak_password") return jsonError(400, "Choose a stronger password.");
    // Don't reveal whether an account already exists.
    return jsonError(400, "Couldn't create that account. Check the details and try again.");
  }
  // With email confirmation on, there is no session until the link is followed.
  return NextResponse.json({ ok: true, confirmEmail: !data.session });
}

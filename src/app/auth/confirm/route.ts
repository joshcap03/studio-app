import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Target of the sign-up confirmation and password reset emails. Verifying the link signs
// the user in; a reset then goes on to choose a password. Two link styles arrive here:
// - token_hash (supabase/templates/, needs custom SMTP on hosted Supabase): works from any browser.
// - code (Supabase's default templates): exchanged with the verifier cookie set when the
//   email was requested, so it works in the browser that asked for it.
const NEXT = new Set(["/onboarding", "/reset-password"]);

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get("token_hash");
  const type = params.get("type") as EmailOtpType | null;
  const code = params.get("code");
  const next = params.get("next");
  const recovery = type === "recovery" || next === "/reset-password";
  const supabase = await createSupabaseServerClient();

  let ok = false;
  if (tokenHash && type) ok = !(await supabase.auth.verifyOtp({ type, token_hash: tokenHash })).error;
  else if (code) ok = !(await supabase.auth.exchangeCodeForSession(code)).error;

  if (ok) {
    const target = next && NEXT.has(next) ? next : recovery ? "/reset-password" : "/onboarding";
    return NextResponse.redirect(new URL(target, request.url));
  }
  return NextResponse.redirect(new URL(recovery ? "/login?error=reset" : "/login?error=confirm", request.url));
}

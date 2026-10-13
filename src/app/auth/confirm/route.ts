import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Target of the sign-up confirmation and password reset emails (supabase/templates/).
// Verifying the token hash signs the user in; a reset then goes on to choose a password.
export async function GET(request: NextRequest) {
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = request.nextUrl.searchParams.get("type") as EmailOtpType | null;
  if (tokenHash && type) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(new URL(type === "recovery" ? "/reset-password" : "/onboarding", request.url));
    if (type === "recovery") return NextResponse.redirect(new URL("/login?error=reset", request.url));
  }
  return NextResponse.redirect(new URL("/login?error=confirm", request.url));
}

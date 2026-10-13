import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/ui/brand-mark";
import { getSession } from "@/lib/tenant";
import { AuthForm } from "./auth-form";

export const metadata: Metadata = { title: "Sign in" };
// Reads the session, so it renders per request; prerendering it would need server config
// at build time and fail the build when that isn't set.
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; mode?: string; error?: string }> }) {
  if (await getSession()) redirect("/");
  const { next, mode, error } = await searchParams;
  // Only same-site relative paths are allowed as a post-login destination.
  const destination = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-[360px] animate-fade-up">
        <div className="flex items-center gap-2.5">
          <BrandMark size={28} />
          <span className="text-[15px] font-semibold tracking-[-0.01em]">Studio</span>
        </div>
        <AuthForm
          destination={destination}
          initialMode={mode === "signup" ? "signup" : "signin"}
          notice={
            error === "confirm"
              ? "That confirmation link is invalid or expired. Sign in or create the account again."
              : error === "reset"
                ? "That reset link is invalid or expired. Request a new one."
                : null
          }
        />
      </div>
    </main>
  );
}

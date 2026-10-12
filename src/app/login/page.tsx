import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/server";
import { BrandMark } from "@/components/ui/brand-mark";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getSession()) redirect("/");
  const { next } = await searchParams;
  // Only same-site relative paths are allowed as a post-login destination.
  const destination = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="w-full max-w-[340px] animate-fade-up">
        <BrandMark size={32} />
        <h1 className="mt-6 font-display text-[28px] leading-tight tracking-[-0.01em]">Welcome back</h1>
        <p className="mt-1.5 text-[14px] text-fg-3">Sign in to the Studio workspace.</p>
        <LoginForm destination={destination} />
      </div>
    </main>
  );
}

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/ui/brand-mark";
import { getSession } from "@/lib/tenant";
import { PasswordForm } from "./password-form";

export const metadata: Metadata = { title: "New password" };
export const dynamic = "force-dynamic";

// Reached from a password reset email: /auth/confirm has already signed the user in.
export default async function ResetPasswordPage() {
  const session = await getSession();
  if (!session) redirect("/login?error=reset");

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-[360px] animate-fade-up">
        <div className="flex items-center gap-2.5">
          <BrandMark size={28} />
          <span className="text-[15px] font-semibold tracking-[-0.01em]">Studio</span>
        </div>
        <PasswordForm email={session.email} />
      </div>
    </main>
  );
}

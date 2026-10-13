import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/ui/brand-mark";
import { ACTIVE_WORKSPACE_COOKIE, getSession, resolveTenant } from "@/lib/tenant";
import { Onboarding } from "./onboarding";

export const metadata: Metadata = { title: "Get started" };
export const dynamic = "force-dynamic";

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const tenant = await resolveTenant(session, (await cookies()).get(ACTIVE_WORKSPACE_COOKIE)?.value);
  const creating = !tenant || (await searchParams).new === "1";

  return (
    <main className="flex min-h-dvh justify-center px-6 py-14 md:items-center md:py-12">
      <div className="w-full max-w-[460px]">
        <div className="flex items-center gap-2.5">
          <BrandMark size={28} />
          <span className="text-[15px] font-semibold tracking-[-0.01em]">Studio</span>
        </div>
        <Onboarding initialStep={creating ? "workspace" : "connect"} workspaceName={creating ? null : tenant!.workspace.name} canCancel={!!tenant} />
      </div>
    </main>
  );
}

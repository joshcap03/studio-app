import type { Metadata } from "next";
import { HomeView } from "@/components/home/home-view";
import { BrandMark } from "@/components/ui/brand-mark";
import { getCompanions } from "@/lib/companion";
import { previewEnabled } from "@/lib/flags";
import { agentOverviews } from "@/lib/home";
import { firstName } from "@/lib/setup-words";
import { requirePageTenant } from "@/lib/tenant";

export const metadata: Metadata = { title: "Home" };
export const dynamic = "force-dynamic";

// All of the person's agents, to pick one to talk to. Not one agent's page, so it names none
// (no <TabAgent>): opening an agent from here switches to it, and its page names it.
export default async function HomePage() {
  const tenant = await requirePageTenant();
  const [agents, companions] = await Promise.all([
    agentOverviews(tenant),
    // Who each agent is to this member (a preview); without it, the Studio mark.
    previewEnabled(tenant, "companion")
      ? getCompanions(tenant).catch((error) => {
          console.error("[companion] unavailable", error);
          return null;
        })
      : null,
  ]);

  return (
    <main className="min-h-dvh px-5 pt-6 pb-24 md:px-8 md:pt-10">
      <div className="mx-auto max-w-[880px]">
        <div className="flex items-center gap-2.5">
          <BrandMark size={24} />
          <span className="text-[14.5px] font-semibold tracking-[-0.01em]">Studio</span>
        </div>
        <div className="mt-8">
          <HomeView agents={agents} current={tenant.workspace.id} member={firstName(tenant.account.name)} companions={companions} />
        </div>
      </div>
    </main>
  );
}

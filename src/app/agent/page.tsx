import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import { AgentView } from "@/components/agent/agent-view";
import { requirePageTenant } from "@/lib/tenant";
import { brainMemories, listPromotions } from "@/lib/brain";
import { previewEnabled } from "@/lib/flags";
import { listMemories, memoryEnabled } from "@/lib/memory";
import { getSettings, getUsage } from "@/lib/workspace";

export const metadata: Metadata = { title: "Agent" };
export const dynamic = "force-dynamic";

export default async function AgentPage() {
  const tenant = await requirePageTenant();
  const brain = previewEnabled(tenant, "brain");
  const memories = memoryEnabled()
    ? (brain ? brainMemories(tenant) : listMemories(tenant)).catch((error) => {
        console.error("[agent] memory unavailable", error);
        return null;
      })
    : Promise.resolve(null);
  const promotions = brain && memoryEnabled() ? listPromotions(tenant).catch(() => []) : Promise.resolve(null);
  const [settings, initialMemories, usage, initialPromotions] = await Promise.all([
    getSettings(tenant),
    memories,
    getUsage(tenant),
    promotions,
  ]);

  return (
    <main className="min-h-dvh px-5 pt-6 pb-24 md:px-8 md:pt-10">
      <div className="mx-auto max-w-[640px]">
        <a
          href="/"
          className="-ml-2 inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13.5px] text-fg-3 transition-colors hover:bg-hover hover:text-fg"
        >
          <ArrowLeft size={15} />
          Back to chat
        </a>
        <AgentView
          initialSettings={settings}
          initialMemories={initialMemories}
          initialPromotions={initialPromotions}
          usage={usage}
          canEdit={tenant.workspace.role === "owner"}
        />
      </div>
    </main>
  );
}

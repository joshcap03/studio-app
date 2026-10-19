import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import { AgentView } from "@/components/agent/agent-view";
import { getAgentAdapter } from "@/lib/agent";
import { listAgentFiles } from "@/lib/agent-files";
import { requirePageTenant } from "@/lib/tenant";
import { brainMemories, listPromotions } from "@/lib/brain";
import { getCompanion } from "@/lib/companion";
import { previewEnabled } from "@/lib/flags";
import { listMemories, memoryEnabled } from "@/lib/memory";
import { barScore, describeScore } from "@/lib/verdicts";
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
  const companion = previewEnabled(tenant, "companion") ? getCompanion(tenant).catch(() => null) : Promise.resolve(null);
  const [settings, initialMemories, usage, initialPromotions, files, score, initialCompanion] = await Promise.all([
    getSettings(tenant),
    memories,
    getUsage(tenant),
    promotions,
    listAgentFiles(tenant),
    barScore(tenant).then(describeScore, () => null),
    companion,
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
          initialFiles={files}
          allowFiles={getAgentAdapter().capabilities.attachments}
          score={score}
          initialCompanion={initialCompanion}
        />
      </div>
    </main>
  );
}

import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import { AgentView } from "@/components/agent/agent-view";
import { TabAgent } from "@/components/tab-agent";
import { getAgentAdapter } from "@/lib/agent";
import { listAgentFiles } from "@/lib/agent-files";
import { requirePageTenant } from "@/lib/tenant";
import { brainMemories, listPromotions } from "@/lib/brain";
import { getCompanion, withToMeet } from "@/lib/companion";
import { previewEnabled } from "@/lib/flags";
import { listMemories, memoryEnabled } from "@/lib/memory";
import { barScore, describeScore } from "@/lib/verdicts";
import { defaultPersona } from "@/lib/voice/persona";
import { voiceStatus } from "@/lib/voice/status";
import { getSettings } from "@/lib/workspace";

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
  // Who it is to them (companions), and how it sounds (voice): both on the member's own row.
  const named = previewEnabled(tenant, "companion");
  const voice = voiceStatus(tenant);
  const companion = named || voice ? getCompanion(tenant).catch(() => null) : Promise.resolve(null);
  const [settings, initialMemories, initialPromotions, files, score, initialCompanion] = await Promise.all([
    getSettings(tenant),
    memories,
    promotions,
    listAgentFiles(tenant),
    barScore(tenant).then(describeScore, () => null),
    companion,
  ]);
  const met = named && initialCompanion ? await withToMeet(tenant, initialCompanion, settings.setup).catch(() => initialCompanion) : null;

  return (
    <main className="min-h-dvh px-5 pt-6 pb-24 md:px-8 md:pt-10">
      <TabAgent id={tenant.workspace.id} />
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
          canEdit={tenant.workspace.role === "owner"}
          initialFiles={files}
          allowFiles={getAgentAdapter().capabilities.attachments}
          score={score}
          initialCompanion={met}
          voice={
            voice && initialCompanion
              ? { status: voice, start: defaultPersona(settings.templateId), keptName: named ? initialCompanion.name : null, voice: initialCompanion.voice, manner: initialCompanion.manner }
              : null
          }
        />
      </div>
    </main>
  );
}

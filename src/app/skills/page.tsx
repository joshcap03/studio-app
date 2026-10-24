import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";
import { SkillsView } from "@/components/skills/skills-view";
import { TabAgent } from "@/components/tab-agent";
import { storeFor } from "@/lib/chat/store-for";
import { listSkills } from "@/lib/skills";
import { draftFromConversation } from "@/lib/skills/render";
import { requirePageTenant } from "@/lib/tenant";

export const metadata: Metadata = { title: "Skills" };
export const dynamic = "force-dynamic";

export default async function SkillsPage({ searchParams }: { searchParams: Promise<{ from?: string | string[] }> }) {
  const tenant = await requirePageTenant();
  const canEdit = tenant.workspace.role === "owner";
  const skills = await listSkills(tenant);

  // "Save as skill" from a conversation: only the caller's own, loaded through their store.
  let initialDraft = null;
  const from = z.uuid().safeParse((await searchParams).from);
  if (canEdit && from.success) {
    const store = storeFor(tenant);
    const conversation = await store.getConversation(from.data);
    if (conversation) {
      const messages = await store.listMessages(conversation.id);
      // A message sent with a skill contributes that skill's steps, not just the added details.
      const requests = messages
        .filter((m) => m.role === "user")
        .map((m) => {
          const used = m.skill && skills.find((s) => s.id === m.skill?.id);
          return used ? [m.content, used.instructions].filter((t) => t.trim()).join("\n") : m.content;
        });
      initialDraft = draftFromConversation(conversation.title, requests);
    }
  }

  return (
    <main className="min-h-dvh px-5 pt-6 pb-24 md:px-8 md:pt-10">
      <TabAgent id={tenant.workspace.id} />
      <div className="mx-auto max-w-[760px]">
        <a
          href="/"
          className="-ml-2 inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13.5px] text-fg-3 transition-colors hover:bg-hover hover:text-fg"
        >
          <ArrowLeft size={15} />
          Back to chat
        </a>
        <h1 className="mt-6 font-display text-[30px] leading-tight tracking-[-0.015em]">Skills</h1>
        <p className="mt-1 max-w-[560px] text-[14px] leading-relaxed text-fg-3">
          Ready-made instructions for tasks you do often. Pick one with <kbd className="rounded border border-line px-1 font-sans text-[12.5px]">/</kbd> in the chat box, add any details, and send. A skill only goes to the agent on the message you use it with.
        </p>
        <SkillsView initialSkills={skills} canEdit={canEdit} initialDraft={initialDraft} />
      </div>
    </main>
  );
}

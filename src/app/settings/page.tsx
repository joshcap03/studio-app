import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import { SettingsView } from "@/components/settings/settings-view";
import { requirePageTenant } from "@/lib/tenant";
import { getGuardrail } from "@/lib/workspace";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const tenant = await requirePageTenant();
  const guardrail = await getGuardrail(tenant);

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
        <h1 className="mt-6 font-display text-[30px] leading-tight tracking-[-0.015em]">Settings</h1>
        <p className="mt-1 text-[14px] text-fg-3">
          Yours, shared by all your agents. To change what {tenant.workspace.name} does, open{" "}
          <a href="/agent" className="text-fg-2 underline decoration-line-strong underline-offset-2 hover:text-fg">
            agent setup
          </a>
          .
        </p>
        <SettingsView email={tenant.email} guardrail={guardrail} account={tenant.account} />
      </div>
    </main>
  );
}

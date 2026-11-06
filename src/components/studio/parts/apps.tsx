"use client";

import { Check } from "lucide-react";
import { useState } from "react";
import { AppGlyph } from "@/components/chat/app-glyph";
import { appForToolkit } from "@/lib/apps";
import type { StandingKind } from "@/lib/approvals/standing";
import { api } from "@/lib/client/api";
import { approvalsLine, ASKS } from "@/lib/studio";
import type { ConnectionsState, MessageSkill } from "@/lib/types";
import { DescribeBar, quietLink } from "../ask-link";
import { PartHead, Unread } from "./shared";

// Where the agent can act: the apps the member connected, and the ones its template still wants.

export function AppsPart({
  connections,
  allowed,
  suggested,
  onDescribe,
}: {
  connections: ConnectionsState | null;
  allowed: StandingKind[] | null;
  suggested: string[];
  onDescribe: (text: string | null, skill?: MessageSkill | null) => void;
}) {
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = connections?.configured ? connections.toolkits.filter((t) => t.status === "connected" || suggested.includes(t.slug)) : [];

  async function connect(slug: string) {
    setConnecting(slug);
    setError(null);
    try {
      window.location.assign((await api.connectApp(slug, "/studio")).url);
    } catch {
      setError("Couldn't start connecting. Try again.");
      setConnecting(null);
    }
  }

  return (
    <>
      <PartHead title="Apps" hint="Where it can act for you. Your connections are shared by all your agents.">
        <a href="/settings" className={quietLink}>
          Manage in Settings
        </a>
      </PartHead>
      {connections === null ? (
        <Unread>Your apps couldn&apos;t be checked just now.</Unread>
      ) : !connections.configured ? (
        <Unread>Connected apps aren&apos;t available here yet.</Unread>
      ) : shown.length === 0 ? (
        <Unread>No apps yet. Ask it to use one, and it&apos;ll give you a link to connect it.</Unread>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {[...shown]
            .sort((a, b) => Number(b.status === "connected") - Number(a.status === "connected"))
            .map((t) => (
              <li key={t.slug} className="flex items-center gap-3 px-3.5 py-2.5">
                <AppGlyph app={appForToolkit(t.slug)} size={18} />
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg">{t.name}</span>
                {t.status === "connected" ? (
                  <Check size={15} className="text-success" aria-label="Connected" />
                ) : t.status === "pending" ? (
                  <span className="text-[12.5px] text-fg-3">Not finished</span>
                ) : (
                  <button type="button" disabled={connecting !== null} onClick={() => void connect(t.slug)} className={`${quietLink} text-fg-2 disabled:opacity-50`}>
                    {connecting === t.slug ? "Opening…" : "Connect"}
                  </button>
                )}
              </li>
            ))}
        </ul>
      )}
      {error ? <p className="mt-2 text-[12.5px] text-danger">{error}</p> : null}
      <p className="mt-3 text-[13px] leading-relaxed text-fg-3">{approvalsLine(allowed ?? [])}</p>
      <div className="mt-4">
        <DescribeBar lead={ASKS.app} placeholder="Or name another app for it to use" onDescribe={onDescribe} />
      </div>
    </>
  );
}

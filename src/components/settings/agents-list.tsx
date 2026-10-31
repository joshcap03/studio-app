"use client";

import { Check, Plus } from "lucide-react";
import { useState } from "react";
import { OnHomeSwitch } from "@/components/ui/on-home-switch";
import { api } from "@/lib/client/api";
import { AGENT_HEADER } from "@/lib/client/tab-agent";
import { MAX_AGENTS, type WorkspaceSettings, type WorkspaceSummary } from "@/lib/types";

/**
 * The member's agents: which take asks from Home, one to add, and one to delete they own. Deleting
 * asks once, in the row, and takes the agent's chats, tasks, skills, files, and memory with it.
 */
export function AgentsList({ initial, current, homeEnabled = false }: { initial: WorkspaceSummary[]; current: string; homeEnabled?: boolean }) {
  const [agents, setAgents] = useState(initial);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owned = agents.filter((a) => a.role === "owner").length;
  const full = owned >= MAX_AGENTS;
  /** With the Home preview and several agents, each row says whether it's on Home. */
  const several = homeEnabled && agents.length > 1;

  async function remove(id: string) {
    setBusy(id);
    setError(null);
    try {
      const { next } = await api.deleteAgent(id);
      if (id === current || !next) {
        window.location.assign(next ? "/settings" : "/onboarding");
        return;
      }
      setAgents((list) => list.filter((a) => a.id !== id));
      setConfirming(null);
    } catch (e) {
      setError((e as Error).message || "Couldn't delete that agent. Try again.");
    } finally {
      setBusy(null);
    }
  }

  /** Each row's agent is named on the request, since this page's tab is on one of them only. */
  async function setOnHome(id: string, onHome: boolean) {
    setBusy(id);
    setError(null);
    setAgents((list) => list.map((a) => (a.id === id ? { ...a, onHome } : a)));
    try {
      const res = await fetch("/api/workspace/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", [AGENT_HEADER]: id },
        body: JSON.stringify({ onHome }),
      });
      const body = (await res.json().catch(() => null)) as { settings?: WorkspaceSettings; error?: string } | null;
      if (!res.ok || !body?.settings) throw new Error(body?.error ?? "Couldn't change that. Try again.");
    } catch (e) {
      setAgents((list) => list.map((a) => (a.id === id ? { ...a, onHome: !onHome } : a)));
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      {several ? <p className="mb-2 text-[13px] text-fg-3">Home sends asks to the agents that are on it. The others you reach from the agent menu.</p> : null}
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {agents.map((a) =>
          confirming === a.id ? (
            <li key={a.id} className="bg-danger-soft px-4 py-3">
              <p className="text-[14px] font-medium">Delete {a.name}?</p>
              <p className="mt-0.5 text-[13px] text-fg-2">Its chats, tasks, skills, files, and memory go with it. This can&apos;t be undone.</p>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy === a.id}
                  onClick={() => void remove(a.id)}
                  className="h-8 rounded-lg bg-danger px-3 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  {busy === a.id ? "Deleting…" : "Delete agent"}
                </button>
                <button
                  type="button"
                  disabled={busy === a.id}
                  onClick={() => setConfirming(null)}
                  className="h-8 rounded-lg px-3 text-[13px] text-fg-2 hover:bg-hover hover:text-fg disabled:opacity-60"
                >
                  Cancel
                </button>
              </div>
            </li>
          ) : (
            <li key={a.id} className="flex items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{a.name}</span>
              {a.id === current ? (
                <span className="flex shrink-0 items-center gap-1 text-[12.5px] text-fg-3">
                  <Check size={13} aria-hidden="true" />
                  Open here
                </span>
              ) : null}
              {several ? (
                <span className="flex shrink-0 items-center gap-2 text-[12.5px] text-fg-3">
                  {a.onHome ? "On Home" : "Draft"}
                  {a.role === "owner" ? <OnHomeSwitch on={a.onHome} busy={busy === a.id} onToggle={() => void setOnHome(a.id, !a.onHome)} label={`On Home: ${a.name}`} /> : null}
                </span>
              ) : null}
              {a.role === "owner" ? (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => {
                    setError(null);
                    setConfirming(a.id);
                  }}
                  className="shrink-0 text-[13px] text-fg-3 hover:text-danger disabled:opacity-40"
                >
                  Delete
                </button>
              ) : (
                <span className="shrink-0 text-[12.5px] text-fg-3">Shared with you</span>
              )}
            </li>
          ),
        )}
      </ul>
      <div className="mt-3 flex items-center justify-between gap-4">
        <span className="text-[13px] text-fg-3">
          {owned} of {MAX_AGENTS} agents
        </span>
        {full ? (
          <span className="text-[13px] text-fg-3">Delete one to add another.</span>
        ) : (
          <a href="/onboarding?new=1" className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-fg-2 hover:text-fg">
            <Plus size={14} aria-hidden="true" />
            New agent
          </a>
        )}
      </div>
      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
    </div>
  );
}

"use client";

import { Check, Plus } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/client/api";
import { MAX_AGENTS, type WorkspaceSummary } from "@/lib/types";

/**
 * The member's agents, to add one or delete one they own. Deleting asks once, in the row, and
 * takes the agent's chats, tasks, skills, files, and memory with it.
 */
export function AgentsList({ initial, current }: { initial: WorkspaceSummary[]; current: string }) {
  const [agents, setAgents] = useState(initial);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owned = agents.filter((a) => a.role === "owner").length;
  const full = owned >= MAX_AGENTS;

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

  return (
    <div>
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

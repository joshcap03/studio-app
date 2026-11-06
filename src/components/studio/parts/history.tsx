"use client";

import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { formatWhen } from "@/components/tasks/shared";
import { LineDiff } from "@/components/ui/line-diff";
import { ApiError, api } from "@/lib/client/api";
import type { AgentRevision } from "@/lib/revisions";
import type { WorkspaceSettings, WorkspaceSkill } from "@/lib/types";
import { secondaryAsk } from "../ask-link";
import { PartHead, Unread } from "./shared";

// Every earlier version of the brief and the skills. Open one to see how it differs from now, and
// put it back; a restore is itself a change here, so it can be undone the same way.

const PART_NAMES = { profile: "What it's for", instructions: "How it works" } as const;

function name(r: AgentRevision): string {
  return r.part === "skill" ? (r.skill?.name ?? "A skill") : PART_NAMES[r.part];
}

function title(r: AgentRevision): string {
  if (r.deleted) return r.mine ? `You removed ${name(r)}` : `${name(r)} was removed`;
  return r.mine ? `You changed ${name(r)}` : `${name(r)} changed`;
}

const skillText = (s: { name: string; description: string; instructions: string }) => [s.name, s.description, "", s.instructions].join("\n");

export function HistoryPart({ settings, skills, owner, onRestored }: { settings: WorkspaceSettings | null; skills: WorkspaceSkill[] | null; owner: boolean; onRestored: () => Promise<void> }) {
  const [revisions, setRevisions] = useState<AgentRevision[] | null | "failed">(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    return api.listRevisions(signal).then(
      ({ revisions: list }) => setRevisions(list),
      () => {
        if (!signal?.aborted) setRevisions("failed");
      },
    );
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function current(r: AgentRevision): { before: string; after: string } {
    if (r.part === "skill") {
      const now = skills?.find((s) => s.id === r.skillId);
      return { before: r.skill ? skillText(r.skill) : "", after: now ? skillText(now) : "" };
    }
    const now = r.part === "profile" ? settings?.profile : settings?.agentInstructions;
    return { before: r.text ?? "", after: now ?? "" };
  }

  async function restore(r: AgentRevision) {
    setBusy(r.id);
    setNotice(null);
    try {
      await api.restoreRevision(r.id);
      await onRestored();
      await load();
      setOpen(null);
      setNotice(`${name(r)} is back. Live on the next reply.`);
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : "Couldn't restore it. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PartHead title="History" hint="Earlier versions of the brief and skills. Try things; you can always go back." />
      {notice ? (
        <p role="status" className="mb-3 text-[13px] text-fg-3">
          {notice}
        </p>
      ) : null}
      {!owner ? (
        <Unread>Only the owner can see history.</Unread>
      ) : revisions === "failed" ? (
        <Unread>History couldn&apos;t be read just now.</Unread>
      ) : revisions === null ? (
        <div aria-busy="true" className="h-24 animate-pulse rounded-xl bg-subtle/60" />
      ) : revisions.length === 0 ? (
        <Unread>Nothing yet. When the brief or a skill changes, its earlier version shows up here.</Unread>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {revisions.map((r) => {
            const { before, after } = open === r.id ? current(r) : { before: "", after: "" };
            return (
              <li key={r.id}>
                <button type="button" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)} className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-hover">
                  <ChevronRight size={14} className={`shrink-0 text-fg-4 transition-transform ${open === r.id ? "rotate-90" : ""}`} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg">{title(r)}</span>
                  <span className="shrink-0 text-[12px] text-fg-4">{formatWhen(r.createdAt)}</span>
                </button>
                {open === r.id ? (
                  <div className="border-t border-line px-3.5 py-3 animate-fade-in">
                    <LineDiff before={before} after={after} gone="This version" added="Now" />
                    <button type="button" disabled={busy !== null} onClick={() => void restore(r)} className={`${secondaryAsk} mt-3`}>
                      {busy === r.id ? "Restoring…" : "Restore this version"}
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

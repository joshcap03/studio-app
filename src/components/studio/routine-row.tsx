"use client";

import { useState } from "react";
import { scheduleText } from "@/components/tasks/shared";
import type { StudioTask } from "@/lib/client/studio";
import { api } from "@/lib/client/api";
import { ASKS, routineChain } from "@/lib/studio";
import type { WorkspaceSkill } from "@/lib/types";
import { Ask, quietLink } from "./ask-link";

// One thing the agent does on its own (a task, with its watch if it has one), read left to right:
// When → I do → I keep → You hear. Four labeled cells, so it reads the same stacked on a phone. A view
// of what's stored, never a second way to configure it: "Start it" turns a template's task on, and
// changing it is an ask.

export function RoutineRow({
  task,
  skills,
  collections,
  owner,
  onGo,
  onOpen,
  onChanged,
}: {
  task: StudioTask;
  skills: WorkspaceSkill[];
  collections: string[];
  owner: boolean;
  onGo: (path: string) => void;
  /** Opens the task's own page. */
  onOpen: (id: string) => void;
  onChanged: (task: StudioTask) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chain = routineChain(task, {
    when: scheduleText(task),
    skill: skills.find((s) => s.id === task.skillId)?.name ?? null,
    watch: task.watch,
    collections,
    lastRun: task.lastRun,
  });

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const { task: next } = await api.updateTask(task.id, { status: "active" });
      onChanged({ ...task, ...next });
    } catch {
      setError("Couldn't start it. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const cell = "min-w-0";
  const cellLabel = "block text-[11px] font-medium tracking-[0.02em] uppercase text-fg-4";
  const cellText = `mt-0.5 block text-[13.5px] leading-[1.4] [overflow-wrap:anywhere] ${chain.notStarted ? "text-fg-3" : "text-fg"}`;

  return (
    <li className="py-3.5 first:pt-0 last:pb-0">
      <div className="grid gap-x-4 gap-y-2 sm:grid-cols-4">
        <span className={cell}>
          <span className={cellLabel}>When</span>
          <span className={cellText}>{chain.when}</span>
        </span>
        <span className={cell}>
          <span className={cellLabel}>I do</span>
          <a
            href={`/tasks/${task.id}`}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              onOpen(task.id);
            }}
            className={`${cellText} underline-offset-2 hover:underline`}
          >
            {chain.does}
          </a>
        </span>
        <span className={cell}>
          <span className={cellLabel}>I keep</span>
          <span className={cellText}>{chain.keeps ? `Your ${chain.keeps.replace(/[_-]+/g, " ")} list` : "Nothing listed, just the chat"}</span>
        </span>
        <span className={cell}>
          <span className={cellLabel}>You hear</span>
          <span className={`${cellText} ${task.lastRun?.status === "failed" || task.watch?.status === "broken" ? "text-danger" : ""}`}>{chain.hear}</span>
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {chain.notStarted && owner ? (
          <button type="button" disabled={busy} onClick={() => void start()} className={`${quietLink} text-fg-2 disabled:opacity-50`}>
            {busy ? "Starting…" : "Start it"}
          </button>
        ) : null}
        <Ask text={ASKS.routineChange(task.title)} onGo={onGo} tone="quiet">
          {chain.notStarted ? "Tell me how you'd like it done" : "Change this"}
        </Ask>
        {error ? <span className="text-[12.5px] text-danger">{error}</span> : null}
      </div>
    </li>
  );
}

"use client";

import type { StudioTask } from "@/lib/client/studio";
import { ASKS } from "@/lib/studio";
import type { MessageSkill, WorkspaceSkill } from "@/lib/types";
import { DescribeBar, quietLink } from "../ask-link";
import { RoutineRow } from "../routine-row";
import { PartHead, Unread } from "./shared";

// What the agent does on its own: each task, read as a chain. Its own page has the rest.

/** Active routines first, then paused ones waiting to be started, then the rest. */
function rank(task: StudioTask): number {
  return task.status === "active" ? 0 : task.status === "paused" ? 1 : 2;
}

export function RoutinesPart({
  tasks,
  skills,
  collections,
  owner,
  onGo,
  onDescribe,
  onTasks,
}: {
  tasks: StudioTask[] | null;
  skills: WorkspaceSkill[];
  collections: string[];
  owner: boolean;
  onGo: (path: string) => void;
  onDescribe: (text: string | null, skill?: MessageSkill | null) => void;
  onTasks: (tasks: StudioTask[]) => void;
}) {
  const shown = [...(tasks ?? [])].filter((t) => t.status !== "archived").sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
  return (
    <>
      <PartHead title="Routines" hint="What it does on its own, and how you hear about it.">
        <button type="button" onClick={() => onGo("/tasks")} className={quietLink}>
          All tasks
        </button>
      </PartHead>
      {tasks === null ? (
        <Unread>Its routines couldn&apos;t be read just now.</Unread>
      ) : shown.length === 0 ? (
        <Unread>Nothing yet. Say what it should do while you&apos;re away, and it&apos;ll suggest a routine.</Unread>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface px-3.5 py-3">
          {shown.map((t) => (
            <RoutineRow key={t.id} task={t} skills={skills} collections={collections} owner={owner} onDescribe={onDescribe} onOpen={(id) => onGo(`/tasks/${id}`)} onChanged={(next) => onTasks((tasks ?? []).map((x) => (x.id === next.id ? next : x)))} />
          ))}
        </ul>
      )}
      <div className="mt-4">
        <DescribeBar lead={ASKS.routine} placeholder="While you're away, it should…" onDescribe={onDescribe} />
      </div>
    </>
  );
}

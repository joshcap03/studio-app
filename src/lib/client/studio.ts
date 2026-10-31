import type { StandingKind } from "@/lib/approvals/standing";
import type { AgentTask, TaskRun, TaskWatch, TrackerSummary } from "@/lib/tasks/types";
import type { Attachment, Companion, ConnectionsState, LibraryItem, Memory, WorkspaceSettings, WorkspaceSkill, WorkspaceSummary } from "@/lib/types";
import { api } from "./api";

// What the agent's own page (src/components/studio) shows, gathered from the routes the app
// already has. Each part is loaded on its own and tolerates failing: a part that can't be read is
// null and the page says so for that part, rather than showing nothing at all.

export interface StudioTask extends AgentTask {
  lastRun: TaskRun | null;
  /** What it watches for in a connected app, where the "watches" preview is on; null otherwise. */
  watch: TaskWatch | null;
}

export interface StudioData {
  settings: WorkspaceSettings | null;
  role: WorkspaceSummary["role"] | null;
  companion: Companion | null;
  /** null when memory isn't set up or couldn't be read (not the same as no facts). */
  memories: Memory[] | null;
  files: Attachment[] | null;
  library: { items: LibraryItem[]; trackers: TrackerSummary[] } | null;
  connections: ConnectionsState | null;
  allowed: StandingKind[] | null;
  tasks: StudioTask[] | null;
  skills: WorkspaceSkill[] | null;
}

const quiet = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

export async function loadStudio(signal: AbortSignal): Promise<StudioData> {
  const [settings, companion, memories, files, library, connections, allowed, tasks, skills] = await Promise.all([
    quiet(api.getSettings(signal)),
    quiet(api.getCompanion()),
    quiet(api.listMemories(signal)),
    quiet(api.listAgentFiles(signal)),
    quiet(api.listLibrary(signal)),
    quiet(api.getConnections(signal)),
    quiet(api.allowedActions()),
    quiet(api.listTasks(signal).then(({ tasks }) => withRunsAndWatches(tasks, signal))),
    quiet(api.listSkills(signal)),
  ]);
  return {
    settings: settings?.settings ?? null,
    role: settings?.role ?? null,
    companion: companion?.companion ?? null,
    memories: memories?.memories ?? null,
    files: files?.files ?? null,
    library,
    connections,
    allowed: allowed?.allowed ?? null,
    tasks,
    skills: skills?.skills ?? null,
  };
}

/** Each task's last run, and its watch where the preview answers (one 404 and the rest aren't asked). */
async function withRunsAndWatches(tasks: AgentTask[], signal: AbortSignal): Promise<StudioTask[]> {
  const runs = await Promise.all(tasks.map((t) => quiet(api.listTaskRuns(t.id, signal))));
  const watches: (TaskWatch | null)[] = tasks.map(() => null);
  const first = tasks.length > 0 ? await quiet(api.getWatch(tasks[0].id, signal)) : null;
  if (first) {
    watches[0] = first.watch;
    const rest = await Promise.all(tasks.slice(1).map((t) => quiet(api.getWatch(t.id, signal))));
    rest.forEach((r, i) => (watches[i + 1] = r?.watch ?? null));
  }
  return tasks.map((task, i) => ({ ...task, lastRun: runs[i]?.runs[0] ?? null, watch: watches[i] }));
}

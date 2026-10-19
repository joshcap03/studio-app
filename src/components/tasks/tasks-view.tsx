"use client";

import { ChevronRight, ListChecks, Plus, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { MAX_TASK_INSTRUCTIONS_LENGTH, MAX_TASK_TITLE_LENGTH } from "@/lib/tasks/schema";
import type { AgentTask, TaskRun } from "@/lib/tasks/types";
import type { WorkspaceSkill } from "@/lib/types";
import {
  browserZone,
  draftFrom,
  errorText,
  field,
  formatWhen,
  iconButton,
  label,
  NeedsYouBadge,
  primary,
  RunBadge,
  ScheduleFields,
  scheduleFrom,
  scheduleText,
  secondary,
  StatusPill,
  taskSkills,
  useNeedsYou,
} from "./shared";

// The member's tasks: work the agent keeps doing over time, on a schedule or when they run it.

interface Props {
  skills: WorkspaceSkill[];
  onOpen: (taskId: string) => void;
}

type ListState = { status: "loading" } | { status: "ready"; tasks: AgentTask[] } | { status: "error" };

export function TasksView({ skills, onOpen }: Props) {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api
      .listTasks(controller.signal)
      .then(({ tasks }) => setState({ status: "ready", tasks }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "error" });
      });
    return () => controller.abort();
  }, []);

  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-4 md:px-8">
      <div className="mx-auto w-full max-w-[46rem] pt-6 pb-[max(24px,env(safe-area-inset-bottom))] md:pt-[6vh]">
        <div className="flex flex-wrap items-end justify-between gap-3 animate-fade-up">
          <div className="min-w-0">
            <h1 className="font-display text-[28px] leading-tight tracking-[-0.015em] text-fg md:text-[32px]">Tasks</h1>
            <p className="mt-1 max-w-[520px] text-[14px] leading-relaxed text-fg-3">
              Ongoing work the agent picks up on a schedule or when you run it. It keeps a plan and a tracker for each one.
            </p>
          </div>
          <button type="button" className={primary} onClick={() => setCreating(true)}>
            <Plus size={14} />
            New task
          </button>
        </div>

        {state.status === "loading" ? (
          <div className="mt-10 flex justify-center" aria-busy="true">
            <span className="spinner animate-fade-in [animation-delay:200ms]" aria-label="Loading tasks" />
          </div>
        ) : state.status === "error" ? (
          <p role="alert" className="mt-8 text-[13.5px] text-danger">
            Couldn&apos;t load your tasks. Check your connection and reload the page.
          </p>
        ) : state.tasks.length === 0 ? (
          <div className="mt-8 rounded-xl border border-dashed border-line px-4 py-8 text-center">
            <ListChecks size={20} strokeWidth={1.75} className="mx-auto text-fg-3" />
            <p className="mt-2 text-[13.5px] text-fg-3">No tasks yet. Give me something to keep working on.</p>
          </div>
        ) : (
          <ul className="mt-6 divide-y divide-line rounded-xl border border-line bg-surface animate-fade-up [animation-delay:60ms]">
            {state.tasks.map((task) => (
              <TaskRow key={task.id} task={task} onOpen={onOpen} />
            ))}
          </ul>
        )}
      </div>

      <Dialog.Root open={creating} onOpenChange={setCreating}>
        {creating ? <NewTask skills={taskSkills(skills)} onCreated={(task) => onOpen(task.id)} /> : null}
      </Dialog.Root>
    </div>
  );
}

function TaskRow({ task, onOpen }: { task: AgentTask; onOpen: (id: string) => void }) {
  const [lastRun, setLastRun] = useState<TaskRun | null>(null);
  const needsYou = useNeedsYou(task.conversationId);

  useEffect(() => {
    const controller = new AbortController();
    api
      .listTaskRuns(task.id, controller.signal)
      .then(({ runs }) => setLastRun(runs[0] ?? null))
      .catch(() => undefined);
    return () => controller.abort();
  }, [task.id]);

  return (
    <li>
      <a
        href={`/tasks/${task.id}`}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          onOpen(task.id);
        }}
        className="flex items-center gap-3 px-4 py-3 transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-hover"
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-[14px] font-medium text-fg">{task.title}</span>
            <StatusPill status={task.status} />
            {needsYou ? <NeedsYouBadge /> : null}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12.5px] text-fg-3">
            <span>{scheduleText(task)}</span>
            {task.nextRunAt ? <span>Next {formatWhen(task.nextRunAt)}</span> : null}
            {lastRun ? (
              <span>
                Last run <RunBadge run={lastRun} /> {formatWhen(lastRun.scheduledFor)}
              </span>
            ) : task.lastRunAt ? (
              <span>Last run {formatWhen(task.lastRunAt)}</span>
            ) : null}
          </div>
        </div>
        <ChevronRight size={15} className="shrink-0 text-fg-4" aria-hidden="true" />
      </a>
    </li>
  );
}

export function TaskSheet({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/20 animate-fade-in" />
      <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] max-w-[560px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-line bg-surface p-6 shadow-pop animate-fade-up">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <Dialog.Title className="text-[16px] font-semibold tracking-[-0.01em]">{title}</Dialog.Title>
            {description ? (
              <Dialog.Description className="mt-1 text-[13.5px] leading-relaxed text-fg-3">{description}</Dialog.Description>
            ) : (
              <Dialog.Description className="sr-only">{title}</Dialog.Description>
            )}
          </div>
          <Dialog.Close aria-label="Close" className={`${iconButton} -mt-1 -mr-2`}>
            <X size={16} />
          </Dialog.Close>
        </div>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  );
}

function NewTask({ skills, onCreated }: { skills: WorkspaceSkill[]; onCreated: (task: AgentTask) => void }) {
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [skillId, setSkillId] = useState("");
  const [schedule, setSchedule] = useState(() => draftFrom(null));
  const [zone] = useState(browserZone);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { task } = await api.createTask({ title, instructions, skillId: skillId || null, schedule: scheduleFrom(schedule), timezone: zone });
      onCreated(task);
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  }

  return (
    <TaskSheet title="New task" description="What the agent should keep working on. It writes its own plan on the first run, and you can edit it.">
      <form onSubmit={save} className="mt-5 space-y-4">
        <label className="block">
          <span className={label}>Title</span>
          <input
            required
            autoFocus
            maxLength={MAX_TASK_TITLE_LENGTH}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Find and apply to product roles"
            className={`mt-1.5 h-10 ${field}`}
          />
        </label>
        <label className="block">
          <span className={label}>Instructions</span>
          <textarea
            rows={6}
            maxLength={MAX_TASK_INSTRUCTIONS_LENGTH}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="What to look for, what good looks like, and anything to avoid."
            className={`mt-1.5 resize-y py-3 leading-relaxed ${field}`}
          />
        </label>
        {skills.length > 0 ? (
          <label className="block">
            <span className={label}>Skill</span>
            <select value={skillId} onChange={(e) => setSkillId(e.target.value)} className={`mt-1.5 h-10 ${field}`}>
              <option value="">None</option>
              {skills.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <ScheduleFields draft={schedule} onChange={setSchedule} zone={zone} />
        <div className="flex items-center justify-end gap-3 pt-1">
          {error ? (
            <p role="alert" className="mr-auto text-[13px] text-danger">
              {error}
            </p>
          ) : null}
          <Dialog.Close className={secondary} type="button">
            Cancel
          </Dialog.Close>
          <button type="submit" disabled={saving || !title.trim()} className={primary}>
            {saving ? "Creating…" : "Create task"}
          </button>
        </div>
      </form>
    </TaskSheet>
  );
}

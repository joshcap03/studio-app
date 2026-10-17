"use client";

import { ArrowLeft, Check, ExternalLink, MessageSquare, Pause, Play, Plus, Trash2, Zap } from "lucide-react";
import { AlertDialog, Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/client/api";
import { MAX_PLAN_STEPS, MAX_TASK_INSTRUCTIONS_LENGTH, MAX_TASK_TITLE_LENGTH } from "@/lib/tasks/schema";
import type { AgentRecord, AgentTask, PlanStep, StepStatus, TaskRun } from "@/lib/tasks/types";
import type { WorkspaceSkill } from "@/lib/types";
import {
  browserZone,
  draftFrom,
  errorText,
  field,
  formatDay,
  formatWhen,
  iconButton,
  label,
  NeedsYouBadge,
  primary,
  RunBadge,
  runReason,
  ScheduleFields,
  scheduleFrom,
  scheduleText,
  secondary,
  StatusPill,
  taskSkills,
  useNeedsYou,
} from "./shared";
import { TaskSheet } from "./tasks-view";

// One task: its plan, settings, tracker, and runs, with controls to run, pause, or delete it.

interface Props {
  taskId: string;
  skills: WorkspaceSkill[];
  onBack: () => void;
  onOpenConversation: (conversationId: string) => void;
  /** Called with the title once loaded, for the page header. */
  onTitle: (title: string | null) => void;
}

type TaskState = { status: "loading" } | { status: "ready"; task: AgentTask } | { status: "missing" } | { status: "error" };

const card = "rounded-2xl border border-line bg-surface p-4";
const STEP_LABEL: Partial<Record<StepStatus, string>> = { doing: "In progress", blocked: "Blocked", needs_you: "Needs you" };

export function TaskDetail({ taskId, skills, onBack, onOpenConversation, onTitle }: Props) {
  const [state, setState] = useState<TaskState>({ status: "loading" });
  const [runs, setRuns] = useState<TaskRun[] | null>(null);
  const [records, setRecords] = useState<AgentRecord[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState<"run" | "status" | null>(null);
  const task = state.status === "ready" ? state.task : null;
  const needsYou = useNeedsYou(task?.conversationId ?? null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    api
      .getTask(taskId, signal)
      .then(({ task }) => setState({ status: "ready", task }))
      .catch((error: unknown) => {
        if (!signal.aborted) setState({ status: error instanceof ApiError && error.status === 404 ? "missing" : "error" });
      });
    api
      .listTaskRuns(taskId, signal)
      .then(({ runs }) => setRuns(runs))
      .catch(() => undefined);
    api
      .listRecords(signal)
      .then(({ records }) => setRecords(records.filter((r) => r.taskId === taskId)))
      .catch(() => undefined);
    return () => controller.abort();
  }, [taskId]);

  const title = task?.title ?? null;
  useEffect(() => {
    onTitle(title);
    return () => onTitle(null);
  }, [onTitle, title]);

  const setTask = (next: AgentTask) => setState({ status: "ready", task: next });

  async function patch(fields: Parameters<typeof api.updateTask>[1]): Promise<AgentTask | null> {
    setNotice(null);
    try {
      const { task } = await api.updateTask(taskId, fields);
      setTask(task);
      return task;
    } catch (error) {
      setNotice(errorText(error));
      return null;
    }
  }

  async function runNow() {
    setBusy("run");
    setNotice(null);
    try {
      const { conversationId } = await api.runTask(taskId);
      onOpenConversation(conversationId);
    } catch (error) {
      setNotice(error instanceof ApiError && error.status === 404 ? "Run now isn't available yet." : errorText(error));
      setBusy(null);
    }
  }

  async function toggleStatus() {
    if (!task) return;
    setBusy("status");
    await patch({ status: task.status === "paused" ? "active" : "paused" });
    setBusy(null);
  }

  async function remove() {
    setNotice(null);
    try {
      await api.deleteTask(taskId);
      onBack();
    } catch (error) {
      setDeleting(false);
      setNotice(errorText(error));
    }
  }

  if (state.status === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center" aria-busy="true">
        <span className="spinner animate-fade-in [animation-delay:200ms]" aria-label="Loading task" />
      </div>
    );
  }
  if (!task) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 pb-[10vh] text-center animate-fade-up">
        <h2 className="font-display text-[24px] tracking-[-0.01em]">{state.status === "missing" ? "This task isn't here" : "Couldn't load this task"}</h2>
        <p className="mt-2 max-w-sm text-[14px] text-fg-3">
          {state.status === "missing" ? "It may have been deleted." : "Check your connection and reload the page."}
        </p>
        <button type="button" onClick={onBack} className={`mt-6 ${secondary}`}>
          <ArrowLeft size={14} />
          All tasks
        </button>
      </div>
    );
  }

  const skill = task.skillId ? skills.find((s) => s.id === task.skillId) : null;
  const canRun = task.status !== "archived";

  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-4 md:px-8">
      <div className="mx-auto w-full max-w-[46rem] pt-4 pb-[max(24px,env(safe-area-inset-bottom))] md:pt-[4vh]">
        <a
          href="/tasks"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            onBack();
          }}
          className="-ml-2 inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13.5px] text-fg-3 transition-colors hover:bg-hover hover:text-fg"
        >
          <ArrowLeft size={15} />
          Tasks
        </a>

        <div className="mt-3 animate-fade-up">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 font-display text-[26px] leading-tight tracking-[-0.015em] break-words text-fg md:text-[30px]">{task.title}</h1>
            <StatusPill status={task.status} />
            {needsYou ? <NeedsYouBadge /> : null}
          </div>
          <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-fg-3">
            <div className="flex gap-1.5">
              <dt className="sr-only">Schedule</dt>
              <dd>{scheduleText(task)}</dd>
            </div>
            {task.schedule ? (
              <div className="flex gap-1.5">
                <dt>Next run</dt>
                <dd className="text-fg-2">{task.nextRunAt ? formatWhen(task.nextRunAt) : task.status === "paused" ? "Paused" : "Not scheduled"}</dd>
              </div>
            ) : null}
            {task.lastRunAt ? (
              <div className="flex gap-1.5">
                <dt>Last run</dt>
                <dd className="text-fg-2">{formatWhen(task.lastRunAt)}</dd>
              </div>
            ) : null}
          </dl>

          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={primary} onClick={runNow} disabled={!canRun || busy !== null}>
              <Zap size={14} />
              {busy === "run" ? "Starting…" : "Run now"}
            </button>
            {task.status === "active" || task.status === "paused" ? (
              <button type="button" className={secondary} onClick={toggleStatus} disabled={busy !== null}>
                {task.status === "paused" ? <Play size={14} /> : <Pause size={14} />}
                {task.status === "paused" ? "Resume" : "Pause"}
              </button>
            ) : null}
            {task.conversationId ? (
              <button type="button" className={secondary} onClick={() => onOpenConversation(task.conversationId!)}>
                <MessageSquare size={14} />
                Open conversation
              </button>
            ) : null}
            <button type="button" className={`${secondary} hover:text-danger sm:ml-auto`} onClick={() => setDeleting(true)}>
              <Trash2 size={14} />
              Delete
            </button>
          </div>
          {notice ? (
            <p role="alert" className="mt-3 text-[13px] text-danger">
              {notice}
            </p>
          ) : null}
        </div>

        <div className="mt-6 space-y-3 animate-fade-up [animation-delay:60ms]">
          <PlanCard plan={task.plan} onSave={(plan) => patch({ plan })} />

          <section className={card} aria-labelledby="task-settings">
            <div className="flex items-center gap-2">
              <h2 id="task-settings" className="flex-1 text-[13.5px] font-medium text-fg">
                Instructions
              </h2>
              <button type="button" className={secondary} onClick={() => setEditing(true)}>
                Edit
              </button>
            </div>
            <p className={`mt-2 text-[13.5px] leading-relaxed whitespace-pre-wrap ${task.instructions ? "text-fg-2" : "text-fg-3"}`}>
              {task.instructions || "No instructions yet. The agent works from the title alone."}
            </p>
            <dl className="mt-3 grid gap-x-4 gap-y-1 border-t border-line pt-3 text-[13px] sm:grid-cols-[auto_1fr]">
              <dt className="text-fg-3">Skill</dt>
              <dd className="text-fg-2">{skill ? skill.name : task.skillId ? "A skill that's no longer here" : "None"}</dd>
              <dt className="text-fg-3">Schedule</dt>
              <dd className="text-fg-2">{scheduleText(task)}</dd>
            </dl>
          </section>

          <Tracker records={records} onChange={setRecords} onError={setNotice} />

          <section className={card} aria-labelledby="task-runs">
            <h2 id="task-runs" className="text-[13.5px] font-medium text-fg">
              Runs
            </h2>
            {runs === null ? (
              <p className="mt-2 text-[13px] text-fg-3">Loading…</p>
            ) : runs.length === 0 ? (
              <p className="mt-2 text-[13px] text-fg-3">No runs yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {runs.map((run) => (
                  <li key={run.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 text-[13px]">
                    <span className="text-fg-2">{formatWhen(run.scheduledFor)}</span>
                    <RunBadge run={run} />
                    {runReason(run) ? <span className="w-full text-[12.5px] text-fg-3 sm:w-auto sm:flex-1">{runReason(run)}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <Dialog.Root open={editing} onOpenChange={setEditing}>
        {editing ? (
          <TaskEditor
            task={task}
            skills={taskSkills(skills)}
            onSave={async (fields) => {
              if (await patch(fields)) setEditing(false);
            }}
          />
        ) : null}
      </Dialog.Root>

      <AlertDialog.Root open={deleting} onOpenChange={setDeleting}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/20 animate-fade-in" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-32px)] max-w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-surface p-6 shadow-pop animate-fade-up">
            <AlertDialog.Title className="text-[16px] font-semibold tracking-[-0.01em]">Delete task?</AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-[14px] leading-relaxed text-fg-2">
              <span className="font-medium text-fg">{task.title}</span>, its plan, and its run history will be permanently deleted. Its
              conversation stays in your chats.
            </AlertDialog.Description>
            <div className="mt-6 flex justify-end gap-2">
              <AlertDialog.Cancel className="h-9 rounded-lg px-3.5 text-[13.5px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg">
                Cancel
              </AlertDialog.Cancel>
              <AlertDialog.Action
                onClick={remove}
                className="h-9 rounded-lg bg-danger px-3.5 text-[13.5px] font-medium text-white transition-opacity hover:opacity-90"
              >
                Delete
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

function PlanCard({ plan, onSave }: { plan: PlanStep[]; onSave: (plan: PlanStep[]) => Promise<AgentTask | null> }) {
  const [adding, setAdding] = useState("");
  // Shown while a save is in flight; the server's copy replaces it when the save lands.
  const [pending, setPending] = useState<PlanStep[] | null>(null);
  const steps = pending ?? plan;
  const done = steps.filter((s) => s.status === "done").length;

  async function save(next: PlanStep[]) {
    setPending(next);
    await onSave(next);
    setPending(null);
  }

  function add(event: React.FormEvent) {
    event.preventDefault();
    const text = adding.trim();
    if (!text) return;
    setAdding("");
    void save([...steps, { id: crypto.randomUUID(), text, status: "todo" }]);
  }

  return (
    <section className={card} aria-labelledby="task-plan">
      <div className="flex items-baseline gap-2">
        <h2 id="task-plan" className="flex-1 text-[13.5px] font-medium text-fg">
          Plan
        </h2>
        {steps.length > 0 ? (
          <span className="text-[12.5px] text-fg-3">
            {done} of {steps.length} done
          </span>
        ) : null}
      </div>
      {steps.length === 0 ? <p className="mt-2 text-[13px] text-fg-3">No plan yet. The agent writes one when it runs, or add steps yourself.</p> : null}
      <ul className="mt-2">
        {steps.map((step) => (
          <PlanItem
            key={step.id}
            step={step}
            onChange={(next) => save(steps.map((s) => (s.id === step.id ? next : s)))}
            onRemove={() => save(steps.filter((s) => s.id !== step.id))}
          />
        ))}
      </ul>
      {steps.length < MAX_PLAN_STEPS ? (
        <form onSubmit={add} className="mt-1 flex items-center gap-2">
          <Plus size={15} className="ml-1.5 shrink-0 text-fg-4" aria-hidden="true" />
          <input
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            maxLength={200}
            placeholder="Add a step"
            aria-label="Add a step"
            className="h-9 min-w-0 flex-1 rounded-lg bg-transparent px-1.5 text-[13.5px] text-fg outline-none placeholder:text-fg-4 focus:bg-subtle focus-visible:outline-none"
          />
          {adding.trim() ? (
            <button type="submit" className={secondary}>
              Add
            </button>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}

function PlanItem({ step, onChange, onRemove }: { step: PlanStep; onChange: (step: PlanStep) => void; onRemove: () => void }) {
  const [text, setText] = useState(step.text);
  useEffect(() => setText(step.text), [step.text]);
  const isDone = step.status === "done";
  const extra = STEP_LABEL[step.status];

  function commit() {
    const next = text.trim();
    if (!next) setText(step.text);
    else if (next !== step.text) onChange({ ...step, text: next });
  }

  return (
    <li className="group/step flex items-start gap-2 py-0.5">
      <button
        type="button"
        role="checkbox"
        aria-checked={isDone}
        aria-label={isDone ? `Mark "${step.text}" not done` : `Mark "${step.text}" done`}
        onClick={() => onChange({ ...step, status: isDone ? "todo" : "done" })}
        className={`mt-2 flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
          isDone ? "border-inverse bg-inverse text-on-inverse" : "border-line-strong hover:bg-hover"
        }`}
      >
        {isDone ? <Check size={12} strokeWidth={2.5} /> : null}
      </button>
      <div className="min-w-0 flex-1">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setText(step.text);
              e.currentTarget.blur();
            }
          }}
          maxLength={200}
          aria-label="Step"
          className={`h-9 w-full rounded-lg bg-transparent px-1.5 text-[13.5px] outline-none focus:bg-subtle focus-visible:outline-none ${
            isDone ? "text-fg-3 line-through" : "text-fg"
          }`}
        />
        {extra || step.note ? (
          <p className="-mt-1 px-1.5 pb-1 text-[12.5px] text-fg-3">
            {extra ? <span className={step.status === "needs_you" ? "font-medium text-accent" : "font-medium text-fg-2"}>{extra}</span> : null}
            {extra && step.note ? " · " : null}
            {step.note}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        aria-label={`Remove "${step.text}"`}
        onClick={onRemove}
        className={`${iconButton} mt-0.5 size-8 opacity-0 group-hover/step:opacity-100 focus-visible:opacity-100 hover:text-danger max-md:opacity-100`}
      >
        <Trash2 size={14} />
      </button>
    </li>
  );
}

function TaskEditor({ task, skills, onSave }: { task: AgentTask; skills: WorkspaceSkill[]; onSave: (fields: Parameters<typeof api.updateTask>[1]) => Promise<void> }) {
  const [title, setTitle] = useState(task.title);
  const [instructions, setInstructions] = useState(task.instructions);
  const [skillId, setSkillId] = useState(task.skillId ?? "");
  const [schedule, setSchedule] = useState(() => draftFrom(task.schedule));
  // Times are entered in the viewer's own zone; saving moves the task to it.
  const [zone] = useState(browserZone);
  const [saving, setSaving] = useState(false);
  const knownSkill = !task.skillId || skills.some((s) => s.id === task.skillId);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    await onSave({ title, instructions, skillId: skillId || null, schedule: scheduleFrom(schedule), timezone: zone });
    setSaving(false);
  }

  return (
    <TaskSheet title="Edit task">
      <form onSubmit={save} className="mt-5 space-y-4">
        <label className="block">
          <span className={label}>Title</span>
          <input required maxLength={MAX_TASK_TITLE_LENGTH} value={title} onChange={(e) => setTitle(e.target.value)} className={`mt-1.5 h-10 ${field}`} />
        </label>
        <label className="block">
          <span className={label}>Instructions</span>
          <textarea
            rows={7}
            maxLength={MAX_TASK_INSTRUCTIONS_LENGTH}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            className={`mt-1.5 resize-y py-3 leading-relaxed ${field}`}
          />
        </label>
        {skills.length > 0 || task.skillId ? (
          <label className="block">
            <span className={label}>Skill</span>
            <select value={skillId} onChange={(e) => setSkillId(e.target.value)} className={`mt-1.5 h-10 ${field}`}>
              <option value="">None</option>
              {!knownSkill ? <option value={task.skillId!}>A skill that&apos;s no longer here</option> : null}
              {skills.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <ScheduleFields draft={schedule} onChange={setSchedule} zone={zone} />
        {task.status === "paused" && schedule.kind !== "none" ? (
          <p className="-mt-2 text-[12.5px] text-fg-3">This task is paused, so it won&apos;t run on schedule until you resume it.</p>
        ) : null}
        <div className="flex items-center justify-end gap-3 pt-1">
          <Dialog.Close className={secondary} type="button">
            Cancel
          </Dialog.Close>
          <button type="submit" disabled={saving || !title.trim()} className={primary}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </TaskSheet>
  );
}

function collectionName(collection: string): string {
  const words = collection.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function Tracker({
  records,
  onChange,
  onError,
}: {
  records: AgentRecord[] | null;
  onChange: (records: AgentRecord[]) => void;
  onError: (message: string | null) => void;
}) {
  if (!records || records.length === 0) {
    return (
      <section className={card} aria-labelledby="task-tracker">
        <h2 id="task-tracker" className="text-[13.5px] font-medium text-fg">
          Tracker
        </h2>
        <p className="mt-2 text-[13px] text-fg-3">{records ? "Nothing tracked yet. The agent adds what it finds here as it works." : "Loading…"}</p>
      </section>
    );
  }

  const groups = new Map<string, AgentRecord[]>();
  for (const r of records) groups.set(r.collection, [...(groups.get(r.collection) ?? []), r]);

  async function setStatus(record: AgentRecord, status: string | null) {
    onError(null);
    try {
      const { record: saved } = await api.updateRecord(record.id, { status });
      onChange(records!.map((r) => (r.id === saved.id ? saved : r)));
    } catch (error) {
      onError(errorText(error));
    }
  }

  async function remove(record: AgentRecord) {
    if (!window.confirm(`Remove "${record.title || record.key}" from the tracker?`)) return;
    onError(null);
    try {
      await api.deleteRecord(record.id);
      onChange(records!.filter((r) => r.id !== record.id));
    } catch (error) {
      onError(errorText(error));
    }
  }

  return (
    <section className={card} aria-labelledby="task-tracker">
      <h2 id="task-tracker" className="text-[13.5px] font-medium text-fg">
        Tracker
      </h2>
      {[...groups].map(([collection, rows]) => (
        <div key={collection} className="mt-3">
          <h3 className="text-[12.5px] font-medium text-fg-3">
            {collectionName(collection)} <span className="font-normal text-fg-4">· {rows.length}</span>
          </h3>
          <div className="-mx-1 mt-1">
            <table className="w-full text-left text-[13px]">
              <thead className="sr-only">
                <tr>
                  <th>Title</th>
                  <th>Status</th>
                  <th className="max-sm:hidden">Updated</th>
                  <th>Remove</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="w-full max-w-0 px-1 py-1.5">
                      {r.url ? (
                        <a href={r.url} target="_blank" rel="noopener noreferrer" className="group/link inline-flex max-w-full items-center gap-1 text-fg hover:underline">
                          <span className="truncate">{r.title || r.key}</span>
                          <ExternalLink size={12} className="shrink-0 text-fg-4" aria-hidden="true" />
                        </a>
                      ) : (
                        <span className="block truncate text-fg">{r.title || r.key}</span>
                      )}
                    </td>
                    <td className="px-1 py-1.5">
                      <RecordStatus record={r} onSave={(status) => setStatus(r, status)} />
                    </td>
                    <td className="px-1 py-1.5 text-right text-[12.5px] whitespace-nowrap text-fg-3 max-sm:hidden">{formatDay(r.updatedAt)}</td>
                    <td className="px-0 py-1.5">
                      <button type="button" aria-label={`Remove ${r.title || r.key}`} onClick={() => remove(r)} className={`${iconButton} hover:text-danger`}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}

function RecordStatus({ record, onSave }: { record: AgentRecord; onSave: (status: string | null) => void }) {
  const [value, setValue] = useState(record.status ?? "");
  useEffect(() => setValue(record.status ?? ""), [record.status]);

  function commit() {
    const next = value.trim() || null;
    if (next !== record.status) onSave(next);
  }

  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setValue(record.status ?? "");
          e.currentTarget.blur();
        }
      }}
      maxLength={40}
      placeholder="No status"
      aria-label={`Status of ${record.title || record.key}`}
      className="h-8 w-[6.5rem] rounded-lg border border-transparent bg-subtle px-2 text-[12.5px] sm:w-[9.5rem] text-fg-2 outline-none transition-colors placeholder:text-fg-4 hover:border-line focus:border-line-strong focus:bg-surface focus-visible:outline-none"
    />
  );
}

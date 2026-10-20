"use client";

import { AlertCircle, FolderOpen, MessageSquare, Plus, ScrollText, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { forwardRef, useRef, useState, useSyncExternalStore } from "react";
import { formatSize, iconFor } from "@/components/chat/attachments";
import { Composer, type ComposerHandle, type MessageExtras } from "@/components/chat/composer";
import { ApiError, api, uploadProjectFile } from "@/lib/client/api";
import {
  ATTACHMENT_TYPES,
  MAX_CONTEXT_LENGTH,
  MAX_PROJECT_FILES,
  type ConversationSummary,
  type Project,
  type WorkspaceSkill,
} from "@/lib/types";
import type { VoiceStatus } from "@/lib/voice/types";

// A project's home: start a chat in it, set the instructions and files the agent gets with
// every message here, and find the project's earlier chats.

interface Props {
  project: Project;
  conversations: ConversationSummary[];
  running: ReadonlySet<string>;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: (text: string, extras?: Partial<MessageExtras>) => void;
  onOpen: (conversationId: string) => void;
  /** Called with the project as the server saved it. */
  onChange: (project: Project) => void;
  skills: WorkspaceSkill[];
  /** Whether the agent can read files (project files and attachments). */
  allowFiles: boolean;
  footnote: React.ReactNode;
  /** Voice for this member, for the message box's mic. */
  voice?: VoiceStatus | null;
}

const card = "flex min-w-0 flex-col rounded-2xl border border-line bg-surface p-4";
const secondary =
  "inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] font-medium text-fg-2 transition-colors hover:border-line-strong hover:bg-hover hover:text-fg disabled:opacity-40";
const ACCEPT = Object.keys(ATTACHMENT_TYPES)
  .map((ext) => `.${ext}`)
  .join(",");

interface Upload {
  key: string;
  name: string;
  error?: string;
}

export const ProjectView = forwardRef<ComposerHandle, Props>(function ProjectView(
  { project, conversations, running, draft, onDraftChange, onSubmit, onOpen, onChange, skills, allowFiles, footnote, voice },
  composerRef,
) {
  const [editing, setEditing] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  // Dates depend on the viewer's time zone, so they render after hydration.
  const hydrated = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );

  async function addFiles(list: FileList) {
    setFileError(null);
    const room = MAX_PROJECT_FILES - project.files.length - uploads.filter((u) => !u.error).length;
    const files = [...list].slice(0, Math.max(0, room));
    if (files.length < list.length) setFileError(`A project can hold up to ${MAX_PROJECT_FILES} files.`);
    let current = project;
    for (const file of files) {
      const key = crypto.randomUUID();
      setUploads((all) => [...all, { key, name: file.name }]);
      try {
        const added = await uploadProjectFile(project.id, file);
        current = { ...current, files: [...current.files, added] };
        onChange(current);
        setUploads((all) => all.filter((u) => u.key !== key));
      } catch (error) {
        const message = error instanceof ApiError ? error.message : "Couldn't upload this file.";
        setUploads((all) => all.map((u) => (u.key === key ? { ...u, error: message } : u)));
      }
    }
  }

  async function removeFile(id: string) {
    setFileError(null);
    const previous = project;
    onChange({ ...project, files: project.files.filter((f) => f.id !== id) });
    try {
      await api.deleteProjectFile(project.id, id);
    } catch {
      onChange(previous);
      setFileError("Couldn't remove that file. Try again.");
    }
  }

  const instructions = project.instructions.trim();
  const showFiles = allowFiles || project.files.length > 0;

  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-4 md:px-8">
      <div className="mx-auto w-full max-w-[46rem] pt-6 pb-[max(24px,env(safe-area-inset-bottom))] md:pt-[8vh]">
        <div className="flex items-center gap-3 animate-fade-up">
          <FolderOpen size={26} strokeWidth={1.5} className="shrink-0 text-fg-3" />
          <h1 className="min-w-0 truncate font-display text-[28px] leading-tight tracking-[-0.015em] text-fg md:text-[32px]">
            {project.name}
          </h1>
        </div>

        <div className="mt-6 animate-fade-up [animation-delay:60ms]">
          <Composer
            ref={composerRef}
            variant="hero"
            initialValue={draft}
            onDraftChange={onDraftChange}
            onSubmit={onSubmit}
            onStop={() => {}}
            running={false}
            placeholder={`New chat in ${project.name}`}
            skills={skills}
            autoFocus
            allowFiles={allowFiles}
            voice={voice}
          />
          {footnote ? <div className="mt-3 text-center">{footnote}</div> : null}
        </div>

        <div className={`mt-6 grid gap-3 animate-fade-up [animation-delay:120ms] ${showFiles ? "md:grid-cols-2" : ""}`}>
          <section className={card} aria-labelledby="project-instructions">
            <div className="flex items-center gap-2">
              <ScrollText size={15} strokeWidth={1.75} className="text-fg-3" />
              <h2 id="project-instructions" className="flex-1 text-[13.5px] font-medium text-fg">
                Instructions
              </h2>
              <button type="button" onClick={() => setEditing(true)} className={secondary}>
                {instructions ? "Edit" : "Add"}
              </button>
            </div>
            <p
              className={`mt-2 line-clamp-4 text-[13.5px] leading-relaxed whitespace-pre-wrap ${instructions ? "text-fg-2" : "text-fg-3"}`}
            >
              {instructions || "Tell the agent how to work in this project: the goal, tone, what to focus on."}
            </p>
          </section>

          {showFiles ? (
            <section className={card} aria-labelledby="project-files">
              <div className="flex items-center gap-2">
                <FolderOpen size={15} strokeWidth={1.75} className="text-fg-3" />
                <h2 id="project-files" className="flex-1 text-[13.5px] font-medium text-fg">
                  Files
                </h2>
                {allowFiles ? (
                  <button
                    type="button"
                    onClick={() => picker.current?.click()}
                    disabled={project.files.length >= MAX_PROJECT_FILES}
                    className={secondary}
                  >
                    <Plus size={14} />
                    Add
                  </button>
                ) : null}
                <input
                  ref={picker}
                  type="file"
                  multiple
                  accept={ACCEPT}
                  hidden
                  onChange={(e) => {
                    if (e.target.files?.length) void addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
              </div>
              {project.files.length === 0 && uploads.length === 0 ? (
                <p className="mt-2 text-[13.5px] leading-relaxed text-fg-3">
                  Add documents the agent should read with every message here, like a brief, price list, or data.
                </p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {project.files.map((f) => {
                    const Icon = iconFor(f.name, f.mimeType);
                    return (
                      <li key={f.id} className="group/file flex h-8 items-center gap-2 rounded-lg px-1 text-[13px]">
                        <Icon size={15} className="shrink-0 text-fg-3" />
                        <span className="min-w-0 flex-1 truncate text-fg">{f.name}</span>
                        <span className="shrink-0 text-[12px] text-fg-3">{formatSize(f.size)}</span>
                        <button
                          type="button"
                          onClick={() => void removeFile(f.id)}
                          aria-label={`Remove ${f.name}`}
                          className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-3 opacity-0 transition-opacity group-hover/file:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100 max-md:opacity-100"
                        >
                          <X size={13} />
                        </button>
                      </li>
                    );
                  })}
                  {uploads.map((u) => (
                    <li key={u.key} className="flex h-8 items-center gap-2 rounded-lg px-1 text-[13px]">
                      {u.error ? (
                        <AlertCircle size={15} className="shrink-0 text-danger" />
                      ) : (
                        <span className="spinner shrink-0" aria-label="Uploading" />
                      )}
                      <span className={`min-w-0 flex-1 truncate ${u.error ? "text-danger" : "text-fg-2"}`} title={u.error}>
                        {u.error ? `${u.name}: ${u.error}` : u.name}
                      </span>
                      {u.error ? (
                        <button
                          type="button"
                          onClick={() => setUploads((all) => all.filter((x) => x.key !== u.key))}
                          aria-label={`Dismiss ${u.name}`}
                          className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-3 hover:bg-hover hover:text-fg"
                        >
                          <X size={13} />
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {fileError ? (
                <p role="status" className="mt-2 text-[12.5px] text-danger">
                  {fileError}
                </p>
              ) : null}
              {!allowFiles ? <p className="mt-2 text-[12.5px] text-fg-3">The agent can&apos;t read files yet.</p> : null}
            </section>
          ) : null}
        </div>

        <section className="mt-8 animate-fade-up [animation-delay:180ms]" aria-labelledby="project-chats">
          <h2 id="project-chats" className="px-1 pb-1 text-[12px] font-medium text-fg-3">
            Chats in this project
          </h2>
          {conversations.length === 0 ? (
            <p className="px-1 py-2 text-[13.5px] text-fg-3">Chats you start here will appear here.</p>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {conversations.map((c) => (
                <li key={c.id}>
                  <a
                    href={`/c/${c.id}`}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                      e.preventDefault();
                      onOpen(c.id);
                    }}
                    className="flex h-12 items-center gap-3 px-1 text-[14px] text-fg transition-colors hover:bg-hover"
                  >
                    <MessageSquare size={15} strokeWidth={1.75} className="shrink-0 text-fg-3" />
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    {running.has(c.id) ? <span className="spinner shrink-0" aria-label="Working" /> : null}
                    <span className="shrink-0 text-[12.5px] text-fg-3">{hydrated ? formatDate(c.updatedAt) : null}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <Dialog.Root open={editing} onOpenChange={setEditing}>
        {editing ? (
          <InstructionsEditor
            project={project}
            onSaved={(saved) => {
              onChange(saved);
              setEditing(false);
            }}
          />
        ) : null}
      </Dialog.Root>
    </div>
  );
});

function InstructionsEditor({ project, onSaved }: { project: Project; onSaved: (project: Project) => void }) {
  const [value, setValue] = useState(project.instructions);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { project: saved } = await api.updateProject(project.id, {
        instructions: value,
      });
      onSaved(saved);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save. Try again.");
      setSaving(false);
    }
  }

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/20 animate-fade-in" />
      <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] max-w-[560px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-line bg-surface p-6 shadow-pop animate-fade-up">
        <Dialog.Title className="text-[16px] font-semibold tracking-[-0.01em]">Project instructions</Dialog.Title>
        <Dialog.Description className="mt-1 text-[13.5px] leading-relaxed text-fg-3">
          The agent follows these in every chat in {project.name}, on top of the workspace&apos;s instructions.
        </Dialog.Description>
        <form onSubmit={save} className="mt-5">
          <textarea
            autoFocus
            rows={10}
            maxLength={MAX_CONTEXT_LENGTH}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. We're planning the spring wholesale catalog. Keep answers short and cite the price list."
            className="w-full resize-y rounded-xl border border-line bg-surface px-3.5 py-3 text-[14.5px] leading-relaxed text-fg outline-none transition-[border-color,box-shadow] placeholder:text-fg-4 focus:border-line-strong focus:shadow-composer focus-visible:outline-none"
          />
          {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close className="h-9 rounded-lg px-3.5 text-[13.5px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg">
              Cancel
            </Dialog.Close>
            <button
              type="submit"
              disabled={saving}
              className="h-9 rounded-lg bg-inverse px-3.5 text-[13.5px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  );
}

const noop = () => () => {};

function formatDate(ms: number): string {
  const date = new Date(ms);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

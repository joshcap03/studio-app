"use client";

import { AlertDialog, Dialog, DropdownMenu } from "radix-ui";
import {
  Check,
  ChevronRight,
  ChevronsUpDown,
  FolderInput,
  FolderMinus,
  FolderOpen,
  LibraryBig,
  ListChecks,
  LogOut,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  SquarePen,
  Trash2,
  Sparkles,
  X,
} from "lucide-react";
import { forwardRef, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BrandMark } from "@/components/ui/brand-mark";
import { IconButton } from "@/components/ui/icon-button";
import { api } from "@/lib/client/api";
import { MAX_PROJECT_NAME_LENGTH, type AgentStatus, type ConversationSummary, type ProjectSummary, type WorkspaceSummary } from "@/lib/types";

interface Props {
  conversations: ConversationSummary[];
  activeId: string | null;
  running: ReadonlySet<string>;
  agent: AgentStatus;
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  email: string | null;
  mod: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onCollapse: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  projects: ProjectSummary[];
  activeProjectId: string | null;
  onSelectProject: (id: string) => void;
  /** Resolves once the project exists (and is open), or rejects with a message to show. */
  onCreateProject: (name: string) => Promise<void>;
  onRenameProject: (id: string, name: string) => void;
  onDeleteProject: (id: string) => void;
  onMove: (conversationId: string, projectId: string | null) => void;
  /** Whether to show Tasks (a preview feature), and whether a Tasks page is open. */
  showTasks: boolean;
  tasksActive: boolean;
  onSelectTasks: () => void;
}

export const Sidebar = forwardRef<HTMLInputElement, Props>(function Sidebar(
  {
    conversations,
    activeId,
    running,
    agent,
    workspace,
    workspaces,
    email,
    mod,
    onSelect,
    onNew,
    onCollapse,
    onRename,
    onDelete,
    projects,
    activeProjectId,
    onSelectProject,
    onCreateProject,
    onRenameProject,
    onDeleteProject,
    onMove,
    showTasks,
    tasksActive,
    onSelectTasks,
  },
  searchRef,
) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ConversationSummary[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ConversationSummary | null>(null);
  const [pendingProjectDelete, setPendingProjectDelete] = useState<ProjectSummary | null>(null);
  const [creating, setCreating] = useState(false);

  // Titles filter instantly; message contents are searched on the server.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api
        .listConversations(q, controller.signal)
        .then((r) => setResults(r.conversations))
        .catch(() => {});
    }, 160);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    // A project's chats live in the project; searching covers every chat.
    if (!q) return conversations.filter((c) => !c.projectId);
    const byTitle = conversations.filter((c) => c.title.toLowerCase().includes(q));
    if (!results) return byTitle;
    const ids = new Set(byTitle.map((c) => c.id));
    // Keep local titles fresh (renames) while merging in content matches.
    const current = new Map(conversations.map((c) => [c.id, c]));
    return [...byTitle, ...results.filter((r) => !ids.has(r.id) && current.has(r.id)).map((r) => current.get(r.id)!)];
  }, [conversations, query, results]);

  const groups = useMemo(() => groupByRecency(visible), [visible]);
  // Recency groups depend on the viewer's time zone, so the list renders after hydration.
  const hydrated = useSyncExternalStore(noop, () => true, () => false);

  return (
    <div className="flex h-full w-[264px] flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between gap-1 pr-2 pl-2">
        <AgentMenu workspace={workspace} workspaces={workspaces} email={email} />
        <IconButton label="Close sidebar" shortcut={`${mod}B`} onClick={onCollapse}>
          <PanelLeftClose size={17} strokeWidth={1.75} />
        </IconButton>
      </div>

      <div className="space-y-0.5 px-2">
        <button
          type="button"
          onClick={onNew}
          className="group/new flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] font-medium text-fg transition-colors hover:bg-hover active:bg-press"
        >
          <SquarePen size={16} strokeWidth={1.75} className="text-fg-2" />
          New chat
          <kbd className="ml-auto font-sans text-[11.5px] font-normal text-fg-4 opacity-0 transition-opacity group-hover/new:opacity-100">
            {mod}⇧O
          </kbd>
        </button>
        {showTasks ? (
          <a
            href="/tasks"
            aria-current={tasksActive ? "page" : undefined}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              onSelectTasks();
            }}
            className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] font-medium text-fg transition-colors hover:bg-hover active:bg-press aria-[current=page]:bg-press"
          >
            <ListChecks size={16} strokeWidth={1.75} className="text-fg-2" />
            Tasks
          </a>
        ) : null}
        <div className="relative">
          <Search size={15} strokeWidth={1.75} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-3" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="Search"
            aria-label="Search conversations"
            className="h-9 w-full rounded-lg bg-transparent pr-8 pl-[34px] text-[13.5px] text-fg outline-none transition-colors placeholder:text-fg-3 hover:bg-hover focus:bg-surface focus:shadow-[inset_0_0_0_1px_var(--line-strong)] focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-3 hover:bg-hover hover:text-fg"
            >
              <X size={13} />
            </button>
          ) : null}
        </div>
      </div>

      <nav aria-label="Conversations" className="scroll-quiet mt-4 min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {query.trim() ? null : (
          <section className="mb-4" aria-labelledby="sidebar-projects">
            <div className="flex items-center pr-1 pb-1 pl-2.5">
              <h2 id="sidebar-projects" className="flex-1 text-[11.5px] font-medium text-fg-3">
                Projects
              </h2>
              <IconButton label="New project" className="size-6!" onClick={() => setCreating(true)}>
                <Plus size={14} />
              </IconButton>
            </div>
            {/* No full-width "New project" row: only the header's plus creates one, so it isn't hit by accident. */}
            <ul>
              {projects.map((p) => {
                const inProject = conversations.filter((c) => c.projectId === p.id);
                // The project on screen, or holding the open chat, shows its latest chats.
                const open = p.id === activeProjectId || inProject.some((c) => c.id === activeId);
                const shown = open ? inProject.slice(0, NESTED_CHATS) : [];
                const current = inProject.find((c) => c.id === activeId);
                if (current && !shown.includes(current)) shown.push(current);
                return (
                  <ProjectItem
                    key={p.id}
                    project={p}
                    active={p.id === activeProjectId}
                    running={inProject.some((c) => running.has(c.id))}
                    onSelect={onSelectProject}
                    onRename={onRenameProject}
                    onDelete={() => setPendingProjectDelete(p)}
                  >
                    {shown.length > 0 ? (
                      <ul className="ml-[17px] border-l border-line pl-1.5">
                        {shown.map((c) => (
                          <ConversationItem
                            key={c.id}
                            conversation={c}
                            active={c.id === activeId}
                            running={running.has(c.id)}
                            onSelect={onSelect}
                            onRename={onRename}
                            onDelete={() => setPendingDelete(c)}
                            canSaveSkill={workspace.role === "owner"}
                            projects={projects}
                            onMove={onMove}
                          />
                        ))}
                      </ul>
                    ) : null}
                  </ProjectItem>
                );
              })}
            </ul>
          </section>
        )}
        {query.trim() ? null : (
          <div className="flex items-center pr-1 pb-1 pl-2.5">
            <h2 className="flex-1 text-[11.5px] font-medium text-fg-3">Chats</h2>
            <IconButton label="New chat" shortcut={`${mod}⇧O`} className="size-6!" onClick={onNew}>
              <Plus size={14} />
            </IconButton>
          </div>
        )}
        {!hydrated ? null : groups.length === 0 ? (
          <p className="px-2.5 py-2 text-[13px] text-fg-3">
            {query.trim() ? "No conversations match." : "Your conversations will appear here."}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.label} className="mb-4 last:mb-0">
              <h2 className={`px-2.5 pb-1 text-[11.5px] font-medium ${query.trim() ? "text-fg-3" : "text-fg-4"}`}>{group.label}</h2>
              <ul>
                {group.items.map((c) => (
                  <ConversationItem
                    key={c.id}
                    conversation={c}
                    active={c.id === activeId}
                    running={running.has(c.id)}
                    onSelect={onSelect}
                    onRename={onRename}
                    onDelete={() => setPendingDelete(c)}
                    canSaveSkill={workspace.role === "owner"}
                    projects={projects}
                    onMove={onMove}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </nav>

      <div className="flex shrink-0 items-center gap-2 border-t border-line py-2 pr-2 pl-4">
        {/* A working agent needs no status line; only a mock or disabled one is worth flagging. */}
        {agent.mode !== "live" ? (
          <span className={`size-1.5 shrink-0 rounded-full ${agent.mode === "mock" ? "bg-accent" : "bg-fg-4"}`} aria-hidden="true" />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-3">
          {agent.mode === "mock" ? "Mock agent · not connected" : agent.mode === "live" ? null : agent.label}
        </span>
        <IconButton label="Skills" side="top" onClick={() => window.location.assign("/skills")}>
          <LibraryBig size={15} strokeWidth={1.75} />
        </IconButton>
        <IconButton label="Agent setup" side="top" onClick={() => window.location.assign("/agent")}>
          <SlidersHorizontal size={15} strokeWidth={1.75} />
        </IconButton>
        <IconButton label="Settings" side="top" onClick={() => window.location.assign("/settings")}>
          <Settings size={15} strokeWidth={1.75} />
        </IconButton>
      </div>

      <AlertDialog.Root open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/20 animate-fade-in" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-32px)] max-w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-surface p-6 shadow-pop animate-fade-up">
            <AlertDialog.Title className="text-[16px] font-semibold tracking-[-0.01em]">Delete conversation?</AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-[14px] leading-relaxed text-fg-2">
              <span className="font-medium text-fg">{pendingDelete?.title}</span> and all of its messages will be
              permanently deleted.
            </AlertDialog.Description>
            <div className="mt-6 flex justify-end gap-2">
              <AlertDialog.Cancel className="h-9 rounded-lg px-3.5 text-[13.5px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg">
                Cancel
              </AlertDialog.Cancel>
              <AlertDialog.Action
                onClick={() => pendingDelete && onDelete(pendingDelete.id)}
                className="h-9 rounded-lg bg-danger px-3.5 text-[13.5px] font-medium text-white transition-opacity hover:opacity-90"
              >
                Delete
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <AlertDialog.Root open={pendingProjectDelete !== null} onOpenChange={(open) => !open && setPendingProjectDelete(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/20 animate-fade-in" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-32px)] max-w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-surface p-6 shadow-pop animate-fade-up">
            <AlertDialog.Title className="text-[16px] font-semibold tracking-[-0.01em]">Delete project?</AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-[14px] leading-relaxed text-fg-2">
              <span className="font-medium text-fg">{pendingProjectDelete?.name}</span>
              {projectContents(pendingProjectDelete ? conversations.filter((c) => c.projectId === pendingProjectDelete.id).length : 0)} will be
              permanently deleted.
            </AlertDialog.Description>
            <div className="mt-6 flex justify-end gap-2">
              <AlertDialog.Cancel className="h-9 rounded-lg px-3.5 text-[13.5px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg">
                Cancel
              </AlertDialog.Cancel>
              <AlertDialog.Action
                onClick={() => pendingProjectDelete && onDeleteProject(pendingProjectDelete.id)}
                className="h-9 rounded-lg bg-danger px-3.5 text-[13.5px] font-medium text-white transition-opacity hover:opacity-90"
              >
                Delete
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <Dialog.Root open={creating} onOpenChange={setCreating}>
        {creating ? (
          <NewProjectDialog
            onCreate={async (name) => {
              await onCreateProject(name);
              setCreating(false);
            }}
          />
        ) : null}
      </Dialog.Root>
    </div>
  );
});

/** What else goes when a project is deleted, after its name. */
function projectContents(chats: number): string {
  if (chats === 0) return " and its files";
  return `, its ${chats === 1 ? "chat" : `${chats} chats`}, and its files`;
}

function NewProjectDialog({ onCreate }: { onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onCreate(name.trim());
    } catch (e) {
      setError((e as Error).message || "Couldn't create the project. Try again.");
      setSaving(false);
    }
  }

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/20 animate-fade-in" />
      <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-32px)] max-w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-surface p-6 shadow-pop animate-fade-up">
        <Dialog.Title className="text-[16px] font-semibold tracking-[-0.01em]">New project</Dialog.Title>
        <Dialog.Description className="mt-1 text-[13.5px] leading-relaxed text-fg-3">
          Keep related chats together, with instructions and files the agent uses in all of them.
        </Dialog.Description>
        <form onSubmit={submit} className="mt-5">
          <input
            autoFocus
            required
            aria-label="Project name"
            maxLength={MAX_PROJECT_NAME_LENGTH}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Spring wholesale catalog"
            className="h-10 w-full rounded-xl border border-line bg-surface px-3.5 text-[14.5px] text-fg outline-none transition-[border-color,box-shadow] placeholder:text-fg-4 focus:border-line-strong focus:shadow-composer focus-visible:outline-none"
          />
          {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close className="h-9 rounded-lg px-3.5 text-[13.5px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg">
              Cancel
            </Dialog.Close>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="h-9 rounded-lg bg-inverse px-3.5 text-[13.5px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {saving ? "Creating…" : "Create project"}
            </button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  );
}

function ProjectItem({
  project,
  active,
  running,
  onSelect,
  onRename,
  onDelete,
  children,
}: {
  project: ProjectSummary;
  active: boolean;
  running: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: () => void;
  /** The project's chats, when it is open. */
  children?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const renaming = useRef(false);

  function commit() {
    const name = input.current?.value.trim();
    setEditing(false);
    if (name && name !== project.name) onRename(project.id, name);
  }

  return (
    <li>
      <div className="group/item relative">
        {editing ? (
          <input
            ref={input}
            defaultValue={project.name}
            aria-label="Project name"
            maxLength={MAX_PROJECT_NAME_LENGTH}
            autoFocus
            onFocus={(e) => e.target.select()}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
            className="h-8 w-full rounded-lg bg-surface px-2.5 text-[13.5px] text-fg shadow-[inset_0_0_0_1px_var(--line-strong)] outline-none focus-visible:outline-none"
          />
        ) : (
          <a
            href={`/p/${project.id}`}
            aria-current={active ? "page" : undefined}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              onSelect(project.id);
            }}
            className="flex h-8 items-center gap-2 rounded-lg pr-8 pl-2.5 text-[13.5px] text-fg-2 transition-colors hover:bg-hover hover:text-fg aria-[current=page]:bg-press aria-[current=page]:text-fg"
          >
            <FolderOpen size={15} strokeWidth={1.75} className="shrink-0 text-fg-3" />
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            {running ? <span className="spinner shrink-0" aria-label="Working" /> : null}
          </a>
        )}
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger
            aria-label={`Options for ${project.name}`}
            hidden={editing}
            className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-3 opacity-0 transition-opacity group-hover/item:opacity-100 hover:bg-press hover:text-fg focus-visible:opacity-100 data-[state=open]:bg-press data-[state=open]:opacity-100 max-md:opacity-100"
          >
            <MoreHorizontal size={15} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              // Renaming moves focus into the name field; don't pull it back to the trigger.
              onCloseAutoFocus={(e) => {
                if (renaming.current) {
                  e.preventDefault();
                  renaming.current = false;
                  input.current?.focus();
                }
              }}
              sideOffset={4}
              className="z-50 min-w-[160px] rounded-xl border border-line bg-surface p-1 shadow-pop animate-fade-in"
            >
              <DropdownMenu.Item
                onSelect={() => {
                  renaming.current = true;
                  setEditing(true);
                }}
                className={menuItem}
              >
                <Pencil size={14} className="text-fg-3" />
                Rename
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={onDelete}
                className="flex h-8 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-danger outline-none data-[highlighted]:bg-danger-soft"
              >
                <Trash2 size={14} />
                Delete
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      {children}
    </li>
  );
}

function ConversationItem({
  conversation,
  active,
  running,
  onSelect,
  onRename,
  onDelete,
  canSaveSkill,
  projects,
  onMove,
}: {
  conversation: ConversationSummary;
  active: boolean;
  running: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: () => void;
  canSaveSkill: boolean;
  projects: ProjectSummary[];
  onMove: (conversationId: string, projectId: string | null) => void;
}) {
  const elsewhere = projects.filter((p) => p.id !== conversation.projectId);
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const renaming = useRef(false);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  function commit() {
    const title = input.current?.value.trim();
    setEditing(false);
    if (title && title !== conversation.title) onRename(conversation.id, title);
  }

  return (
    <li className="group/item relative">
      {editing ? (
        <input
          ref={input}
          defaultValue={conversation.title}
          aria-label="Conversation title"
          maxLength={120}
          autoFocus
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          className="h-8 w-full rounded-lg bg-surface px-2.5 text-[13.5px] text-fg shadow-[inset_0_0_0_1px_var(--line-strong)] outline-none focus-visible:outline-none"
        />
      ) : (
        <a
          href={`/c/${conversation.id}`}
          aria-current={active ? "page" : undefined}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            onSelect(conversation.id);
          }}
          className="flex h-8 items-center gap-2 rounded-lg pr-8 pl-2.5 text-[13.5px] text-fg-2 transition-colors hover:bg-hover hover:text-fg aria-[current=page]:bg-press aria-[current=page]:text-fg"
        >
          <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
          {running ? <span className="spinner shrink-0" aria-label="Working" /> : null}
        </a>
      )}
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger
          aria-label={`Options for ${conversation.title}`}
          hidden={editing}
          className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-3 opacity-0 transition-opacity group-hover/item:opacity-100 hover:bg-press hover:text-fg focus-visible:opacity-100 data-[state=open]:bg-press data-[state=open]:opacity-100 max-md:opacity-100"
        >
          <MoreHorizontal size={15} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            // Renaming moves focus into the title field; don't pull it back to the trigger.
            onCloseAutoFocus={(e) => {
              if (renaming.current) {
                e.preventDefault();
                renaming.current = false;
                input.current?.focus();
                input.current?.select();
              }
            }}
            sideOffset={4}
            className="z-50 min-w-[160px] rounded-xl border border-line bg-surface p-1 shadow-pop animate-fade-in"
          >
            <DropdownMenu.Item
              onSelect={() => {
                renaming.current = true;
                setEditing(true);
              }}
              className="flex h-8 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-fg outline-none data-[highlighted]:bg-hover"
            >
              <Pencil size={14} className="text-fg-3" />
              Rename
            </DropdownMenu.Item>
            {canSaveSkill ? (
              <DropdownMenu.Item
                onSelect={() => window.location.assign(`/skills?from=${conversation.id}`)}
                className="flex h-8 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-fg outline-none data-[highlighted]:bg-hover"
              >
                <Sparkles size={14} className="text-fg-3" />
                Save as skill
              </DropdownMenu.Item>
            ) : null}
            {elsewhere.length > 0 ? (
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger className={`${menuItem} data-[state=open]:bg-hover`}>
                  <FolderInput size={14} className="text-fg-3" />
                  <span className="flex-1">Move to project</span>
                  <ChevronRight size={14} className="text-fg-3" />
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent
                    sideOffset={4}
                    className="z-50 max-h-[320px] max-w-[240px] min-w-[160px] overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-pop animate-fade-in"
                  >
                    {elsewhere.map((p) => (
                      <DropdownMenu.Item key={p.id} onSelect={() => onMove(conversation.id, p.id)} className={menuItem}>
                        <FolderOpen size={14} className="shrink-0 text-fg-3" />
                        <span className="min-w-0 truncate">{p.name}</span>
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            ) : null}
            {conversation.projectId ? (
              <DropdownMenu.Item onSelect={() => onMove(conversation.id, null)} className={menuItem}>
                <FolderMinus size={14} className="text-fg-3" />
                Remove from project
              </DropdownMenu.Item>
            ) : null}
            <DropdownMenu.Item
              onSelect={onDelete}
              className="flex h-8 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-danger outline-none data-[highlighted]:bg-danger-soft"
            >
              <Trash2 size={14} />
              Delete
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </li>
  );
}

const noop = () => () => {};
const NESTED_CHATS = 5;

const menuItem =
  "flex h-8 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-fg outline-none data-[highlighted]:bg-hover";

// One login, several agents. Each agent is stored as a workspace.
function AgentMenu({ workspace, workspaces, email }: { workspace: WorkspaceSummary; workspaces: WorkspaceSummary[]; email: string | null }) {
  async function switchTo(id: string) {
    if (id === workspace.id) return;
    const res = await fetch("/api/workspaces/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: id }),
    });
    if (res.ok) window.location.assign("/");
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="flex h-9 min-w-0 items-center gap-2.5 rounded-lg pr-2 pl-2 text-left transition-colors hover:bg-hover data-[state=open]:bg-hover">
        <BrandMark size={22} />
        <span className="min-w-0 truncate text-[14px] font-semibold tracking-[-0.01em]">{workspace.name}</span>
        <ChevronsUpDown size={13} className="shrink-0 text-fg-3" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="z-50 w-[248px] rounded-xl border border-line bg-surface p-1 shadow-pop animate-fade-in"
        >
          {email ? <div className="truncate px-2.5 pt-1.5 pb-1 text-[12px] text-fg-3">{email}</div> : null}
          <DropdownMenu.Label className="px-2.5 pt-1.5 pb-1 text-[12px] font-medium text-fg-3">Agents</DropdownMenu.Label>
          {workspaces.map((w) => (
            <DropdownMenu.Item key={w.id} onSelect={() => void switchTo(w.id)} className={menuItem}>
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              {w.id === workspace.id ? <Check size={14} className="text-fg-2" /> : null}
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Item onSelect={() => window.location.assign("/onboarding?new=1")} className={`${menuItem} text-fg-2`}>
            <Plus size={14} className="text-fg-3" />
            New agent
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item onSelect={() => window.location.assign("/agent")} className={menuItem}>
            <SlidersHorizontal size={14} className="text-fg-3" />
            <span className="min-w-0 truncate">Set up {workspace.name}</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => window.location.assign("/settings")} className={menuItem}>
            <Settings size={14} className="text-fg-3" />
            Settings
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={() => void api.signOut().finally(() => window.location.assign("/login"))}
            className={menuItem}
          >
            <LogOut size={14} className="text-fg-3" />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function groupByRecency(items: ConversationSummary[]): { label: string; items: ConversationSummary[] }[] {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const day = 86_400_000;
  const buckets: [string, (t: number) => boolean][] = [
    ["Today", (t) => t >= today],
    ["Yesterday", (t) => t >= today - day],
    ["Previous 7 days", (t) => t >= today - 7 * day],
    ["Previous 30 days", (t) => t >= today - 30 * day],
    ["Older", () => true],
  ];
  const groups = buckets.map(([label]) => ({ label, items: [] as ConversationSummary[] }));
  for (const item of items) {
    const index = buckets.findIndex(([, test]) => test(item.updatedAt));
    groups[index].items.push(item);
  }
  return groups.filter((g) => g.items.length > 0);
}

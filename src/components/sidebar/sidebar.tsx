"use client";

import { AlertDialog, DropdownMenu } from "radix-ui";
import { Check, ChevronsUpDown, LogOut, MoreHorizontal, PanelLeftClose, Pencil, Plus, Search, Settings, SquarePen, Trash2, X } from "lucide-react";
import { forwardRef, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BrandMark } from "@/components/ui/brand-mark";
import { IconButton } from "@/components/ui/icon-button";
import { api } from "@/lib/client/api";
import type { AgentStatus, ConversationSummary, WorkspaceSummary } from "@/lib/types";

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
}

export const Sidebar = forwardRef<HTMLInputElement, Props>(function Sidebar(
  { conversations, activeId, running, agent, workspace, workspaces, email, mod, onSelect, onNew, onCollapse, onRename, onDelete },
  searchRef,
) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ConversationSummary[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ConversationSummary | null>(null);

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
    if (!q) return conversations;
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
        <WorkspaceMenu workspace={workspace} workspaces={workspaces} email={email} />
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
        {!hydrated ? null : groups.length === 0 ? (
          <p className="px-2.5 py-2 text-[13px] text-fg-3">
            {query.trim() ? "No conversations match." : "Your conversations will appear here."}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.label} className="mb-4 last:mb-0">
              <h2 className="px-2.5 pb-1 text-[11.5px] font-medium text-fg-3">{group.label}</h2>
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
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </nav>

      <div className="flex shrink-0 items-center gap-2 border-t border-line py-2 pr-2 pl-4">
        <span
          className={`size-1.5 shrink-0 rounded-full ${agent.mode === "live" ? "bg-success" : "bg-accent"}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-3">
          {agent.mode === "live" ? agent.label : "Mock agent · not connected"}
        </span>
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
    </div>
  );
});

function ConversationItem({
  conversation,
  active,
  running,
  onSelect,
  onRename,
  onDelete,
}: {
  conversation: ConversationSummary;
  active: boolean;
  running: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: () => void;
}) {
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

const menuItem =
  "flex h-8 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-fg outline-none data-[highlighted]:bg-hover";

function WorkspaceMenu({ workspace, workspaces, email }: { workspace: WorkspaceSummary; workspaces: WorkspaceSummary[]; email: string | null }) {
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
          {workspaces.map((w) => (
            <DropdownMenu.Item key={w.id} onSelect={() => void switchTo(w.id)} className={menuItem}>
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              {w.id === workspace.id ? <Check size={14} className="text-fg-2" /> : null}
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Item onSelect={() => window.location.assign("/onboarding?new=1")} className={`${menuItem} text-fg-2`}>
            <Plus size={14} className="text-fg-3" />
            New workspace
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
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

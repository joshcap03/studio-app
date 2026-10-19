"use client";

import { Archive, ArrowUpRight, File, MessageSquare, MoreHorizontal, Pencil, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ARTIFACT_KIND_STYLE } from "@/components/chat/artifact-card";
import { errorText, field, formatDay, iconButton, primary, secondary } from "@/components/tasks/shared";
import { Tracker } from "@/components/tasks/tracker";
import { api } from "@/lib/client/api";
import type { AgentRecord } from "@/lib/tasks/types";
import type { Attachment, LibraryItem } from "@/lib/types";

// The member's Library for this agent: the docs and sheets it made for them (filed from its
// tools' own results), links they added, every tracker, and the files they gave it. Docs
// stay where they live; removing one here only takes it off the shelf.

interface Props {
  onOpenConversation: (conversationId: string) => void;
}

type Loaded<T> = T[] | null;

const card = "rounded-2xl border border-line bg-surface p-4";
const menuItem =
  "flex h-8 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-fg outline-none data-[highlighted]:bg-hover";

export function LibraryView({ onOpenConversation }: Props) {
  const [items, setItems] = useState<Loaded<LibraryItem>>(null);
  const [records, setRecords] = useState<Loaded<AgentRecord>>(null);
  const [files, setFiles] = useState<Loaded<Attachment>>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    Promise.all([api.listLibrary(signal), api.listRecords(signal), api.listAgentFiles(signal)])
      .then(([library, tracked, own]) => {
        setItems(library.items);
        setRecords(tracked.records);
        setFiles(own.files);
      })
      .catch(() => {
        if (!signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, []);

  const loading = !failed && (items === null || records === null || files === null);
  const nothing = items?.length === 0 && records?.length === 0 && files?.length === 0;

  function sorted(list: LibraryItem[]): LibraryItem[] {
    return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  }

  async function patch(item: LibraryItem, change: { title?: string; pinned?: boolean }) {
    setNotice(null);
    try {
      const { item: saved } = await api.updateLibraryItem(item.id, change);
      setItems((all) => sorted((all ?? []).map((i) => (i.id === saved.id ? saved : i))));
    } catch (error) {
      setNotice(errorText(error));
    }
  }

  async function remove(item: LibraryItem) {
    if (!window.confirm(`Take "${item.title}" out of your Library? The doc itself stays where it is.`)) return;
    setNotice(null);
    try {
      await api.deleteLibraryItem(item.id);
      setItems((all) => (all ?? []).filter((i) => i.id !== item.id));
    } catch (error) {
      setNotice(errorText(error));
    }
  }

  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-4 md:px-8">
      <div className="mx-auto w-full max-w-[46rem] pt-6 pb-[max(24px,env(safe-area-inset-bottom))] md:pt-[6vh]">
        <div className="flex flex-wrap items-end justify-between gap-3 animate-fade-up">
          <div className="min-w-0">
            <h1 className="font-display text-[28px] leading-tight tracking-[-0.015em] text-fg md:text-[32px]">Library</h1>
            <p className="mt-1 max-w-[520px] text-[14px] leading-relaxed text-fg-3">
              What this agent has made for you and what it keeps track of, in one place. It goes back to these instead of starting over.
            </p>
          </div>
          {adding ? null : (
            <button type="button" className={primary} onClick={() => setAdding(true)}>
              <Plus size={14} />
              Add link
            </button>
          )}
        </div>

        {adding ? (
          <AddLink
            onAdded={(item) => {
              setItems((all) => sorted([item, ...(all ?? [])]));
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        ) : null}

        {notice ? (
          <p role="alert" className="mt-4 text-[13px] text-danger">
            {notice}
          </p>
        ) : null}

        {failed ? (
          <p role="alert" className="mt-8 text-[13.5px] text-danger">
            Couldn&apos;t load your Library. Check your connection and reload the page.
          </p>
        ) : loading ? (
          <div className="mt-10 flex justify-center" aria-busy="true">
            <span className="spinner animate-fade-in [animation-delay:200ms]" aria-label="Loading your Library" />
          </div>
        ) : nothing && !adding ? (
          <div className="mt-8 rounded-xl border border-dashed border-line px-4 py-8 text-center animate-fade-up">
            <Archive size={20} strokeWidth={1.75} className="mx-auto text-fg-3" />
            <p className="mx-auto mt-2 max-w-[420px] text-[13.5px] text-fg-3">
              Nothing here yet. Docs and sheets I make for you land here, and so does anything I track, like job applications. You can add links to docs you already keep.
            </p>
          </div>
        ) : (
          <div className="mt-6 space-y-4 animate-fade-up [animation-delay:60ms]">
            <section className={card} aria-labelledby="library-docs">
              <h2 id="library-docs" className="text-[13.5px] font-medium text-fg">
                Docs &amp; links
              </h2>
              {items && items.length > 0 ? (
                <ul className="-mx-1 mt-2 divide-y divide-line">
                  {items.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      onPin={() => patch(item, { pinned: !item.pinned })}
                      onRename={(title) => patch(item, { title })}
                      onRemove={() => remove(item)}
                      onOpenConversation={onOpenConversation}
                    />
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[13px] text-fg-3">Docs and sheets I make for you show up here. Add a link to one you already keep.</p>
              )}
            </section>

            {records && records.length > 0 ? (
              <Tracker records={records} onChange={setRecords} onError={setNotice} title="Trackers" empty="" />
            ) : null}

            {files && files.length > 0 ? (
              <section className={card} aria-labelledby="library-files">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 id="library-files" className="text-[13.5px] font-medium text-fg">
                    Your files
                  </h2>
                  <a href="/agent" className="text-[12.5px] text-fg-3 hover:text-fg hover:underline">
                    Manage
                  </a>
                </div>
                <p className="mt-1 text-[12.5px] text-fg-3">I read these with every message.</p>
                <ul className="mt-2 space-y-1">
                  {files.map((f) => (
                    <li key={f.id} className="flex items-center gap-2 text-[13px] text-fg">
                      <File size={14} strokeWidth={1.75} className="shrink-0 text-fg-3" />
                      <span className="truncate">{f.name}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function ItemRow({
  item,
  onPin,
  onRename,
  onRemove,
  onOpenConversation,
}: {
  item: LibraryItem;
  onPin: () => void;
  onRename: (title: string) => void;
  onRemove: () => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const kind = ARTIFACT_KIND_STYLE[item.kind] ?? ARTIFACT_KIND_STYLE.file;
  const Icon = kind.icon;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.title);
  const renaming = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  function commit() {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== item.title) onRename(next);
    else setDraft(item.title);
  }

  const origin = item.addedBy === "member" ? "Added by you" : "Made by me";

  return (
    <li className="flex items-center gap-3 px-1 py-2">
      <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${kind.tint}`}>
        <Icon size={18} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setDraft(item.title);
                setEditing(false);
              }
            }}
            maxLength={300}
            aria-label="Name"
            className="h-7 w-full rounded-md border border-line-strong bg-surface px-1.5 text-[14px] text-fg outline-none focus-visible:outline-none"
          />
        ) : (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="group/link flex min-w-0 items-center gap-1 text-[14px] font-medium text-fg hover:underline"
          >
            <span className="truncate">{item.title}</span>
            <ArrowUpRight size={13} className="shrink-0 text-fg-4 transition-colors group-hover/link:text-fg-2" aria-hidden="true" />
          </a>
        )}
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12.5px] text-fg-3">
          <span className="truncate">{item.source ?? kind.label}</span>
          <span aria-hidden="true">·</span>
          {item.conversationId ? (
            <a
              href={`/c/${item.conversationId}`}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                onOpenConversation(item.conversationId!);
              }}
              className="hover:text-fg hover:underline"
            >
              {origin} in a chat
            </a>
          ) : (
            <span>{origin}</span>
          )}
          <span aria-hidden="true">·</span>
          <span>{formatDay(item.updatedAt)}</span>
        </div>
      </div>
      {item.pinned ? <Pin size={13} className="shrink-0 fill-current text-fg-3" aria-label="Pinned" /> : null}
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger aria-label={`Options for ${item.title}`} className={`${iconButton} data-[state=open]:bg-hover`}>
          <MoreHorizontal size={15} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            // Renaming moves focus into the name field; don't pull it back to the trigger.
            onCloseAutoFocus={(e) => {
              if (renaming.current) {
                e.preventDefault();
                renaming.current = false;
                input.current?.focus();
                input.current?.select();
              }
            }}
            className="z-50 min-w-[180px] rounded-xl border border-line bg-surface p-1 shadow-pop animate-fade-in"
          >
            <DropdownMenu.Item onSelect={onPin} className={menuItem}>
              {item.pinned ? <PinOff size={14} className="text-fg-3" /> : <Pin size={14} className="text-fg-3" />}
              {item.pinned ? "Unpin" : "Pin to top"}
            </DropdownMenu.Item>
            {item.conversationId ? (
              <DropdownMenu.Item onSelect={() => onOpenConversation(item.conversationId!)} className={menuItem}>
                <MessageSquare size={14} className="text-fg-3" />
                Open the chat
              </DropdownMenu.Item>
            ) : null}
            <DropdownMenu.Item
              onSelect={() => {
                renaming.current = true;
                setDraft(item.title);
                setEditing(true);
              }}
              className={menuItem}
            >
              <Pencil size={14} className="text-fg-3" />
              Rename
            </DropdownMenu.Item>
            <DropdownMenu.Item
              onSelect={onRemove}
              className="flex h-8 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-danger outline-none data-[highlighted]:bg-danger-soft"
            >
              <Trash2 size={14} />
              Remove
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </li>
  );
}

function AddLink({ onAdded, onCancel }: { onAdded: (item: LibraryItem) => void; onCancel: () => void }) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const link = url.trim();
    if (!link) return;
    setSaving(true);
    setError(null);
    try {
      const { item } = await api.addLibraryLink({ url: /^https?:\/\//i.test(link) ? link : `https://${link}`, title: title.trim() || undefined });
      onAdded(item);
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className={`${card} mt-6 space-y-3 animate-fade-up`} aria-label="Add a link">
      <input
        autoFocus
        // Not type="url": a link pasted without its https:// is fine, it's added on submit.
        type="text"
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Paste a link, like a Google Doc"
        aria-label="Link"
        maxLength={4000}
        className={`${field} h-10`}
      />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Name (optional)"
        aria-label="Name"
        maxLength={300}
        className={`${field} h-10`}
      />
      {error ? (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button type="button" className={secondary} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className={primary} disabled={saving || !url.trim()}>
          {saving ? "Adding…" : "Add"}
        </button>
      </div>
    </form>
  );
}

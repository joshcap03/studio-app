"use client";

import { ArrowUpRight, Check, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useMemo, useState } from "react";
import { AppGlyph } from "@/components/chat/app-glyph";
import { CATALOG, CATALOG_CATEGORIES, type CatalogCategory, type CatalogEntry } from "@/lib/skills/catalog";
import {
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_INSTRUCTIONS_LENGTH,
  MAX_SKILL_NAME_LENGTH,
  type WorkspaceSkill,
} from "@/lib/types";
import { agentHeaders } from "@/lib/client/tab-agent";

interface Draft {
  id?: string;
  name: string;
  description: string;
  instructions: string;
}

interface Props {
  initialSkills: WorkspaceSkill[];
  canEdit: boolean;
  /** Opens the editor on load, e.g. from "Save as skill". */
  initialDraft: Draft | null;
}

const field =
  "w-full rounded-xl border border-line bg-surface px-3.5 text-[14px] text-fg outline-none transition-[border-color,box-shadow] placeholder:text-fg-4 focus:border-line-strong focus:shadow-composer focus-visible:outline-none";
const primary =
  "inline-flex h-8 items-center gap-1.5 rounded-lg bg-inverse px-3 text-[13px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:opacity-30";
const secondary =
  "inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] font-medium text-fg-2 transition-colors hover:border-line-strong hover:bg-hover hover:text-fg disabled:opacity-40";
const iconButton =
  "flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-hover hover:text-fg";

async function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...agentHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !json) throw new Error(json?.error ?? "Something went wrong. Try again.");
  return json;
}

export function SkillsView({ initialSkills, canEdit, initialDraft }: Props) {
  const [skills, setSkills] = useState(initialSkills);
  const [editing, setEditing] = useState<Draft | null>(initialDraft);
  const [preview, setPreview] = useState<CatalogEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const added = useMemo(() => new Set(skills.map((s) => s.catalogId).filter(Boolean)), [skills]);

  // Opened from "Save as skill": drop the query so a reload doesn't reopen the editor.
  useEffect(() => {
    if (initialDraft && window.location.search) window.history.replaceState(null, "", window.location.pathname);
  }, [initialDraft]);

  function upsert(skill: WorkspaceSkill) {
    setSkills((list) => (list.some((s) => s.id === skill.id) ? list.map((s) => (s.id === skill.id ? skill : s)) : [...list, skill]));
  }

  async function addFromLibrary(entry: CatalogEntry) {
    setError(null);
    try {
      upsert((await call<{ skill: WorkspaceSkill }>("/api/workspace/skills", "POST", { catalogId: entry.id })).skill);
    } catch (e) {
      setError((e as Error).message);
    }
    setPreview(null);
  }

  async function remove(skill: WorkspaceSkill) {
    if (!window.confirm(`Remove "${skill.name}" from this agent?`)) return;
    const previous = skills;
    setSkills((list) => list.filter((s) => s.id !== skill.id));
    try {
      await call(`/api/workspace/skills/${skill.id}`, "DELETE");
    } catch (e) {
      setSkills(previous);
      setError((e as Error).message);
    }
  }

  return (
    <div className="mt-10 space-y-14">
      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold tracking-[-0.01em]">This agent's skills</h2>
            <p className="mt-1 text-[13.5px] text-fg-3">
              {canEdit ? "Use these with / in any message." : "Only the owner can add or change skills."}
            </p>
          </div>
          {canEdit ? (
            <button type="button" className={secondary} onClick={() => setEditing({ name: "", description: "", instructions: "" })}>
              <Plus size={14} />
              New skill
            </button>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-[13px] text-danger">
            {error}
          </p>
        ) : null}
        {skills.length === 0 ? (
          <p className="mt-4 rounded-xl border border-dashed border-line px-4 py-6 text-center text-[13.5px] text-fg-3">
            No skills yet. {canEdit ? "Add one from the library below, or write your own." : null}
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-line rounded-xl border border-line bg-surface">
            {skills.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-subtle text-fg-2">
                  <Sparkles size={15} strokeWidth={1.75} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-fg">{s.name}</div>
                  {s.description ? <div className="truncate text-[12.5px] text-fg-3">{s.description}</div> : null}
                </div>
                <a
                  href={`/?skill=${s.id}`}
                  aria-label={`Use ${s.name}`}
                  className={`${secondary} max-sm:w-8 max-sm:justify-center max-sm:px-0`}
                >
                  <ArrowUpRight size={14} />
                  <span className="max-sm:hidden">Use</span>
                </a>
                {canEdit ? (
                  <>
                    <button type="button" aria-label={`Edit ${s.name}`} className={iconButton} onClick={() => setEditing({ ...s })}>
                      <Pencil size={14} />
                    </button>
                    <button type="button" aria-label={`Remove ${s.name}`} className={`${iconButton} hover:text-danger`} onClick={() => remove(s)}>
                      <Trash2 size={14} />
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Library added={added} onOpen={setPreview} />

      <Dialog.Root open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <Sheet title={preview?.name ?? ""} description={preview?.description}>
          {preview ? (
            <>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-[12.5px] text-fg-3">
                <span>{preview.category}</span>
                <span aria-hidden="true">·</span>
                <span className="flex gap-1">
                  {preview.apps.map((a) => (
                    <AppGlyph key={a} app={a} size={18} />
                  ))}
                </span>
              </div>
              <pre className="mt-4 max-h-[40vh] overflow-y-auto rounded-xl bg-subtle px-4 py-3 font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-fg-2">
                {preview.instructions}
              </pre>
              <div className="mt-5 flex justify-end">
                {added.has(preview.id) ? (
                  <span className="inline-flex h-8 items-center gap-1.5 text-[13px] text-fg-3">
                    <Check size={14} />
                    In this workspace
                  </span>
                ) : canEdit ? (
                  <button type="button" className={primary} onClick={() => addFromLibrary(preview)}>
                    <Plus size={14} />
                    Add to workspace
                  </button>
                ) : (
                  <span className="text-[13px] text-fg-3">Ask the owner to add this.</span>
                )}
              </div>
            </>
          ) : null}
        </Sheet>
      </Dialog.Root>

      <Dialog.Root open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing ? (
          <Editor
            key={editing.id ?? "new"}
            initial={editing}
            onSaved={(skill) => {
              upsert(skill);
              setEditing(null);
            }}
          />
        ) : null}
      </Dialog.Root>
    </div>
  );
}

function Library({ added, onOpen }: { added: Set<string | null>; onOpen: (entry: CatalogEntry) => void }) {
  const [category, setCategory] = useState<CatalogCategory | "All">("All");
  const entries = CATALOG.filter((e) => category === "All" || e.category === category);
  const pill = (active: boolean) =>
    `h-7 rounded-full px-3 text-[12.5px] transition-colors ${active ? "bg-inverse text-on-inverse" : "border border-line text-fg-2 hover:bg-hover hover:text-fg"}`;

  return (
    <section>
      <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Library</h2>
      <p className="mt-1 text-[13.5px] text-fg-3">Ready-made skills. Adding one copies it here so you can adapt it.</p>
      <div className="mt-4 flex flex-wrap gap-1.5" role="group" aria-label="Filter the library">
        {(["All", ...CATALOG_CATEGORIES] as const).map((c) => (
          <button key={c} type="button" aria-pressed={category === c} className={pill(category === c)} onClick={() => setCategory(c)}>
            {c}
          </button>
        ))}
      </div>
      <ul className="mt-4 grid gap-2.5 sm:grid-cols-2">
        {entries.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => onOpen(e)}
              className="flex h-full w-full flex-col rounded-xl border border-line bg-surface px-4 py-3.5 text-left transition-colors hover:border-line-strong"
            >
              <div className="flex w-full items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-fg">{e.name}</span>
                {added.has(e.id) ? <Check size={14} className="shrink-0 text-success" aria-label="Added" /> : null}
              </div>
              <p className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-fg-3">{e.description}</p>
              <div className="mt-auto flex items-center gap-1 pt-3">
                {e.apps.map((a) => (
                  <AppGlyph key={a} app={a} size={16} />
                ))}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Sheet({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
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

function Editor({ initial, onSaved }: { initial: Draft; onSaved: (skill: WorkspaceSkill) => void }) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const fields = { name: draft.name, description: draft.description, instructions: draft.instructions };
    try {
      const { skill } = draft.id
        ? await call<{ skill: WorkspaceSkill }>(`/api/workspace/skills/${draft.id}`, "PATCH", fields)
        : await call<{ skill: WorkspaceSkill }>("/api/workspace/skills", "POST", fields);
      onSaved(skill);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      title={draft.id ? "Edit skill" : "New skill"}
      description="What the agent should do when someone uses this. They can add details when they send it."
    >
      <form onSubmit={save} className="mt-5 space-y-4">
        <label className="block">
          <span className="text-[13px] font-medium text-fg-2">Name</span>
          <input
            required
            autoFocus
            maxLength={MAX_SKILL_NAME_LENGTH}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className={`mt-1.5 h-10 ${field}`}
          />
        </label>
        <label className="block">
          <span className="text-[13px] font-medium text-fg-2">Description</span>
          <input
            maxLength={MAX_SKILL_DESCRIPTION_LENGTH}
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="One line on what it does"
            className={`mt-1.5 h-10 ${field}`}
          />
        </label>
        <label className="block">
          <span className="text-[13px] font-medium text-fg-2">Instructions</span>
          <textarea
            required
            rows={9}
            maxLength={MAX_SKILL_INSTRUCTIONS_LENGTH}
            value={draft.instructions}
            onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
            placeholder={"1. Pull last week's orders.\n2. …"}
            className={`mt-1.5 resize-y py-3 leading-relaxed ${field}`}
          />
        </label>
        <div className="flex items-center justify-end gap-3 pt-1">
          {error ? (
            <p role="alert" className="mr-auto text-[13px] text-danger">
              {error}
            </p>
          ) : null}
          <Dialog.Close className={secondary} type="button">
            Cancel
          </Dialog.Close>
          <button type="submit" disabled={saving || !draft.name.trim() || !draft.instructions.trim()} className={primary}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

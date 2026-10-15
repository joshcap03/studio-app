"use client";

import { Check, MessageSquare, Pencil, Pin, PinOff, Trash2, Users, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_LABELS,
  type Memory,
  type MemoryCategory,
  type MemoryPromotion,
} from "@/lib/types";

// Business Brain: what the agent knows, grouped by what it's about, with where each fact
// came from. Members edit, pin, and share their own facts; owners review shares.

interface Props {
  initialMemories: Memory[];
  initialPromotions: MemoryPromotion[];
  isOwner: boolean;
}

async function send<T>(url: string, method: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return { ok: true, data: undefined as T };
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !json) return { ok: false, error: json?.error ?? "Something went wrong. Try again." };
  return { ok: true, data: json };
}

const select =
  "h-7 rounded-md border border-line bg-surface px-1.5 text-[12.5px] text-fg-2 outline-none transition-colors hover:border-line-strong focus-visible:border-line-strong";

export function BusinessBrain({ initialMemories, initialPromotions, isOwner }: Props) {
  const [memories, setMemories] = useState(initialMemories);
  const [promotions, setPromotions] = useState(initialPromotions);
  const [error, setError] = useState<string | null>(null);

  const pendingShare = useMemo(() => new Set(promotions.filter((p) => p.mine).map((p) => p.memoryId)), [promotions]);
  const review = isOwner ? promotions : [];
  const pinned = memories.filter((m) => m.pinned);
  const groups = MEMORY_CATEGORIES.map((c) => ({ category: c, items: memories.filter((m) => !m.pinned && m.category === c) })).filter(
    (g) => g.items.length > 0,
  );

  const replace = (id: string, next: Memory | null) =>
    setMemories((list) => (next ? list.map((m) => (m.id === id ? next : m)) : list.filter((m) => m.id !== id)));

  async function change(memory: Memory, patch: Partial<Pick<Memory, "content" | "category" | "pinned">>) {
    setError(null);
    replace(memory.id, { ...memory, ...patch });
    const result = await send<{ memory: Memory }>(`/api/workspace/memories/${encodeURIComponent(memory.id)}`, "PATCH", patch);
    if (!result.ok) {
      replace(memory.id, memory);
      setError(result.error);
      return;
    }
    // An edit is saved as a new memory, so its id changes.
    setMemories((list) => list.map((m) => (m.id === memory.id ? result.data.memory : m)));
  }

  async function remove(memory: Memory) {
    setError(null);
    replace(memory.id, null);
    const result = await send(`/api/workspace/memories/${encodeURIComponent(memory.id)}`, "DELETE");
    if (!result.ok) {
      setMemories((list) => [memory, ...list]);
      setError(result.error);
    }
  }

  async function share(memory: Memory) {
    setError(null);
    const result = await send<{ promotion: MemoryPromotion }>(`/api/workspace/memories/${encodeURIComponent(memory.id)}/promote`, "POST");
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const promotion = result.data.promotion;
    if (promotion.status === "approved") {
      // An owner's own share is approved at once: the shared copy replaces the personal one.
      await refresh();
      return;
    }
    setPromotions((list) => [...list, promotion]);
  }

  async function decide(promotion: MemoryPromotion, decision: "approve" | "reject") {
    setError(null);
    setPromotions((list) => list.filter((p) => p.id !== promotion.id));
    const result = await send(`/api/workspace/promotions/${promotion.id}`, "POST", { decision });
    if (!result.ok) {
      setPromotions((list) => [...list, promotion]);
      setError(result.error);
      return;
    }
    if (decision === "approve") await refresh();
  }

  async function refresh() {
    const [m, p] = await Promise.all([
      send<{ memories: Memory[] }>("/api/workspace/memories", "GET"),
      send<{ promotions: MemoryPromotion[] }>("/api/workspace/promotions", "GET"),
    ]);
    if (m.ok) setMemories(m.data.memories);
    if (p.ok) setPromotions(p.data.promotions);
  }

  const row = (m: Memory) => (
    <FactRow
      key={m.id}
      memory={m}
      canChange={m.mine || isOwner}
      sharing={pendingShare.has(m.id)}
      onChange={(patch) => change(m, patch)}
      onRemove={() => remove(m)}
      onShare={() => share(m)}
    />
  );

  return (
    <div>
      <AddFact onAdded={(m) => setMemories((list) => [m, ...list])} onError={setError} />
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {error}
        </p>
      ) : null}

      {review.length > 0 ? (
        <div className="mt-6 rounded-xl border border-line bg-subtle/50 p-3">
          <h3 className="px-1 text-[12.5px] font-medium text-fg-2">Waiting for review</h3>
          <ul className="mt-2 space-y-2">
            {review.map((p) => (
              <li key={p.id} className="flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] leading-relaxed text-fg">{p.content}</p>
                  <p className="mt-0.5 text-[12px] text-fg-3">{MEMORY_CATEGORY_LABELS[p.category]} · asked to share with the workspace</p>
                </div>
                <button
                  type="button"
                  onClick={() => decide(p, "reject")}
                  className="h-7 shrink-0 rounded-md px-2 text-[12.5px] text-fg-2 hover:bg-hover hover:text-fg"
                >
                  Reject
                </button>
                <button
                  type="button"
                  onClick={() => decide(p, "approve")}
                  className="h-7 shrink-0 rounded-md bg-inverse px-2.5 text-[12.5px] font-medium text-on-inverse hover:opacity-90"
                >
                  Approve
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {memories.length === 0 ? (
        <p className="mt-4 text-[13.5px] text-fg-3">Nothing saved yet. Add something above, or just tell the agent in chat.</p>
      ) : (
        <div className="mt-6 space-y-6">
          {pinned.length > 0 ? (
            <FactGroup title="Pinned" hint="Always given to the agent">
              {pinned.map(row)}
            </FactGroup>
          ) : null}
          {groups.map((g) => (
            <FactGroup key={g.category} title={MEMORY_CATEGORY_LABELS[g.category]}>
              {g.items.map(row)}
            </FactGroup>
          ))}
        </div>
      )}
    </div>
  );
}

function FactGroup({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-[12.5px] font-medium text-fg-3">
        {title}
        {hint ? <span className="font-normal text-fg-4"> · {hint}</span> : null}
      </h3>
      <ul className="mt-1 divide-y divide-line">{children}</ul>
    </section>
  );
}

interface FactRowProps {
  memory: Memory;
  canChange: boolean;
  sharing: boolean;
  onChange: (patch: Partial<Pick<Memory, "content" | "category" | "pinned">>) => void;
  onRemove: () => void;
  onShare: () => void;
}

function FactRow({ memory: m, canChange, sharing, onChange, onRemove, onShare }: FactRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const iconButton =
    "flex size-7 shrink-0 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg";

  function save() {
    const text = draft.trim();
    setEditing(false);
    if (text && text !== m.content) onChange({ content: text });
    else setDraft(m.content);
  }

  return (
    <li className="group/fact py-3">
      {editing ? (
        <div className="flex items-start gap-2">
          <label htmlFor={`fact-${m.id}`} className="sr-only">
            Edit memory
          </label>
          <textarea
            id={`fact-${m.id}`}
            autoFocus
            onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
            rows={2}
            maxLength={2000}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                setDraft(m.content);
                setEditing(false);
              }
            }}
            className="min-w-0 flex-1 resize-y rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-[14px] leading-relaxed outline-none"
          />
          <button type="button" onClick={save} aria-label="Save" className={iconButton}>
            <Check size={14} />
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(m.content);
              setEditing(false);
            }}
            aria-label="Cancel"
            className={iconButton}
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <p className="text-[14px] leading-relaxed whitespace-pre-wrap text-fg">{m.content}</p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-fg-3">
        {canChange ? (
          <select
            aria-label="Category"
            value={m.category}
            onChange={(e) => onChange({ category: e.target.value as MemoryCategory })}
            className={select}
          >
            {MEMORY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {MEMORY_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        ) : null}
        <span>{m.scope === "personal" ? "Only me" : "Workspace"}</span>
        {m.source ? (
          <a href={`/c/${m.source.conversationId}`} className="inline-flex items-center gap-1 hover:text-fg">
            <MessageSquare size={12} />
            From a conversation
          </a>
        ) : (
          <span>Added by hand</span>
        )}
        {sharing ? <span className="rounded-full border border-line px-2 py-0.5">Waiting for owner</span> : null}
        <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/fact:opacity-100 focus-within:opacity-100 max-md:opacity-100">
          {m.scope === "personal" && !sharing ? (
            <button type="button" onClick={onShare} aria-label="Share with workspace" title="Share with workspace" className={iconButton}>
              <Users size={14} />
            </button>
          ) : null}
          {canChange ? (
            <>
              <button
                type="button"
                onClick={() => onChange({ pinned: !m.pinned })}
                aria-label={m.pinned ? "Unpin" : "Pin"}
                title={m.pinned ? "Unpin" : "Pin: always give this to the agent"}
                className={iconButton}
              >
                {m.pinned ? <PinOff size={14} /> : <Pin size={14} />}
              </button>
              <button type="button" onClick={() => setEditing(true)} aria-label="Edit" title="Edit" className={iconButton}>
                <Pencil size={14} />
              </button>
              <button type="button" onClick={onRemove} aria-label="Forget this" title="Forget this" className={`${iconButton} hover:text-danger`}>
                <Trash2 size={14} />
              </button>
            </>
          ) : null}
        </span>
      </div>
    </li>
  );
}

function AddFact({ onAdded, onError }: { onAdded: (m: Memory) => void; onError: (e: string | null) => void }) {
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<Memory["scope"]>("workspace");
  const [category, setCategory] = useState<MemoryCategory>("other");
  const [pending, setPending] = useState(false);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!content.trim() || pending) return;
    setPending(true);
    onError(null);
    const result = await send<{ memory: Memory }>("/api/workspace/memories", "POST", { content, scope, category });
    setPending(false);
    if (!result.ok) {
      onError(result.error);
      return;
    }
    onAdded(result.data.memory);
    setContent("");
  }

  return (
    <form onSubmit={add} className="rounded-xl border border-line bg-surface p-2 shadow-composer transition-colors focus-within:border-line-strong">
      <label htmlFor="memory" className="sr-only">
        New memory
      </label>
      <textarea
        id="memory"
        rows={2}
        maxLength={2000}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="e.g. Our fiscal year starts in February."
        className="block w-full resize-none bg-transparent px-2 py-1.5 text-[14.5px] leading-relaxed outline-none placeholder:text-fg-4 focus-visible:outline-none"
      />
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 pl-1">
        <div className="flex items-center gap-2">
          <div role="radiogroup" aria-label="Who can see this" className="flex rounded-lg bg-subtle p-0.5 text-[12.5px]">
            {(["workspace", "personal"] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={scope === s}
                onClick={() => setScope(s)}
                className={`h-7 rounded-md px-2.5 transition-colors ${scope === s ? "bg-surface font-medium text-fg shadow-sm" : "text-fg-3 hover:text-fg"}`}
              >
                {s === "workspace" ? "Workspace" : "Only me"}
              </button>
            ))}
          </div>
          <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value as MemoryCategory)} className={select}>
            {MEMORY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {MEMORY_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={!content.trim() || pending}
          className="h-8 rounded-lg bg-inverse px-3 text-[13px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:opacity-30"
        >
          Remember
        </button>
      </div>
    </form>
  );
}

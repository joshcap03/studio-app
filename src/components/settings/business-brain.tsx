"use client";

import { Check, ChevronRight, Combine, MessageSquare, Pencil, Pin, PinOff, Search, Trash2, Users, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_LABELS,
  type Memory,
  type MemoryCategory,
  type MemoryPromotion,
} from "@/lib/types";
import { agentHeaders } from "@/lib/client/tab-agent";

// Business Brain: what the agent knows, grouped by what it's about, with where each fact
// came from. Members edit, pin, and share their own facts; owners review shares. A long Brain
// stays scannable: topics fold up to a count and their newest fact, show a few at a time, and
// a search or a Shared / Only me filter narrows everything at once. "Tidy up" on a topic opens
// a chat where the agent suggests combining overlapping facts, for the member to merge.

interface Props {
  initialMemories: Memory[];
  initialPromotions: MemoryPromotion[];
  isOwner: boolean;
}

async function send<T>(url: string, method: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? agentHeaders() : { "Content-Type": "application/json", ...agentHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return { ok: true, data: undefined as T };
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !json) return { ok: false, error: json?.error ?? "Something went wrong. Try again." };
  return { ok: true, data: json };
}

const select =
  "h-7 rounded-md border border-line bg-surface px-1.5 text-[12.5px] text-fg-2 outline-none transition-colors hover:border-line-strong focus-visible:border-line-strong";

/** Up to this many facts, every topic starts open; past it, topics start folded. */
const OPEN_ALL_UP_TO = 12;
/** Facts an open topic shows before "Show more". */
const PER_TOPIC = 5;
/** A topic offers "Tidy up" from this many facts. */
const TIDY_FROM = 3;

type ScopeFilter = "all" | Memory["scope"];

/** Every word of the query appears in the fact (or its topic's name). */
function matches(m: Memory, words: string[]): boolean {
  const text = `${m.content} ${MEMORY_CATEGORY_LABELS[m.category]}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

export function BusinessBrain({ initialMemories, initialPromotions, isOwner }: Props) {
  const [memories, setMemories] = useState(initialMemories);
  const [promotions, setPromotions] = useState(initialPromotions);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ScopeFilter>("all");

  const pendingShare = useMemo(() => new Set(promotions.filter((p) => p.mine).map((p) => p.memoryId)), [promotions]);
  const review = isOwner ? promotions : [];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const filtering = words.length > 0 || scope !== "all";
  const shown = memories.filter((m) => (scope === "all" || m.scope === scope) && matches(m, words));
  const pinned = shown.filter((m) => m.pinned);
  const groups = MEMORY_CATEGORIES.map((c) => ({ category: c, items: shown.filter((m) => !m.pinned && m.category === c) })).filter(
    (g) => g.items.length > 0,
  );
  const bothScopes = memories.some((m) => m.scope === "personal") && memories.some((m) => m.scope === "workspace");

  // A topic can be tidied once it holds a few facts this member may change (pinned ones too).
  const tidyable = (category: MemoryCategory) => memories.filter((m) => m.category === category && (m.mine || isOwner)).length >= TIDY_FROM;

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
                  <p className="mt-0.5 text-[12px] text-fg-3">{MEMORY_CATEGORY_LABELS[p.category]} · asked to share</p>
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
        <p className="mt-4 text-[13.5px] text-fg-3">Nothing saved yet. Add something above, or just tell me in chat.</p>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 basis-56">
              <Search size={14} strokeWidth={1.75} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-3" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setQuery("");
                }}
                placeholder={`Search ${memories.length} ${memories.length === 1 ? "fact" : "facts"}`}
                aria-label="Search what it knows"
                className="h-8 w-full rounded-lg border border-line bg-surface pr-2.5 pl-8 text-[13px] text-fg outline-none transition-colors placeholder:text-fg-3 hover:border-line-strong focus:border-line-strong focus-visible:outline-none"
              />
            </div>
            {bothScopes ? (
              <div role="radiogroup" aria-label="Whose facts" className="flex rounded-lg bg-subtle p-0.5 text-[12.5px]">
                {(["all", "workspace", "personal"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={scope === s}
                    onClick={() => setScope(s)}
                    className={`h-7 rounded-md px-2.5 transition-colors ${scope === s ? "bg-surface font-medium text-fg shadow-sm" : "text-fg-3 hover:text-fg"}`}
                  >
                    {s === "all" ? "All" : s === "workspace" ? "Shared" : "Only me"}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {shown.length === 0 ? (
            <p className="mt-4 text-[13.5px] text-fg-3">Nothing matches.</p>
          ) : (
            <div className="mt-4 space-y-2">
              {pinned.length > 0 ? (
                <Topic title="Pinned" hint="Always given to the agent" items={pinned} startOpen expanded={filtering}>
                  {row}
                </Topic>
              ) : null}
              {groups.map((g) => (
                <Topic
                  key={g.category}
                  title={MEMORY_CATEGORY_LABELS[g.category]}
                  items={g.items}
                  startOpen={memories.length <= OPEN_ALL_UP_TO}
                  expanded={filtering}
                  tidy={tidyable(g.category) ? g.category : undefined}
                >
                  {row}
                </Topic>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface TopicProps {
  title: string;
  hint?: string;
  items: Memory[];
  startOpen: boolean;
  /** While searching or filtering, every topic with a match opens and shows all of them. */
  expanded: boolean;
  /** Offers "Tidy up": a chat where the agent suggests combining this topic's overlapping facts. */
  tidy?: MemoryCategory;
  children: (m: Memory) => React.ReactNode;
}

/** One topic: folds to its name, count, and newest fact; opens to a few facts at a time. */
function Topic({ title, hint, items, startOpen, expanded, tidy, children }: TopicProps) {
  const [open, setOpen] = useState(startOpen);
  const [limit, setLimit] = useState(PER_TOPIC);
  const isOpen = open || expanded;
  const visible = expanded ? items : items.slice(0, limit);
  const more = items.length - visible.length;

  return (
    <section className="rounded-xl border border-line bg-surface">
      <h3>
        <button
          type="button"
          aria-expanded={isOpen}
          onClick={() => setOpen(!isOpen)}
          disabled={expanded}
          className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors enabled:hover:bg-hover"
        >
          <ChevronRight size={14} className={`shrink-0 text-fg-3 transition-transform ${isOpen ? "rotate-90" : ""}`} />
          <span className="shrink-0 text-[13px] font-medium text-fg">{title}</span>
          <span className="shrink-0 text-[12.5px] tabular-nums text-fg-3">{items.length}</span>
          {isOpen ? (
            hint ? <span className="min-w-0 truncate text-[12.5px] text-fg-4">{hint}</span> : null
          ) : (
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-3">{items[0]?.content}</span>
          )}
        </button>
      </h3>
      {isOpen ? (
        <div className="px-3 pb-1">
          <ul className="divide-y divide-line border-t border-line">{visible.map(children)}</ul>
          {more > 0 || tidy ? (
            <div className="mb-1.5 flex items-center gap-1">
              {more > 0 ? (
                <button
                  type="button"
                  onClick={() => setLimit(items.length)}
                  className="h-7 rounded-md px-1.5 text-[12.5px] text-fg-2 hover:bg-hover hover:text-fg"
                >
                  Show {more} more
                </button>
              ) : null}
              {tidy ? (
                <a
                  href={`/?tidy=${tidy}`}
                  title="The agent suggests combining facts that overlap. Nothing changes until you merge them."
                  className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[12.5px] text-fg-2 hover:bg-hover hover:text-fg"
                >
                  <Combine size={13} />
                  Tidy up
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
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
  const [topic, setTopic] = useState(m.category);
  const [full, setFull] = useState(false);
  // About two lines at this width; longer facts fold until asked.
  const long = m.content.length > 160;
  const iconButton =
    "flex size-7 shrink-0 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg";

  function save() {
    const text = draft.trim();
    setEditing(false);
    const patch: Partial<Pick<Memory, "content" | "category">> = {};
    if (text && text !== m.content) patch.content = text;
    else setDraft(m.content);
    if (topic !== m.category) patch.category = topic;
    if (patch.content !== undefined || patch.category !== undefined) onChange(patch);
  }

  function cancel() {
    setDraft(m.content);
    setTopic(m.category);
    setEditing(false);
  }

  return (
    <li className="group/fact py-2.5">
      {editing ? (
        <div className="flex flex-wrap items-start gap-2">
          <label htmlFor={`fact-${m.id}`} className="sr-only">
            Edit memory
          </label>
          <textarea
            id={`fact-${m.id}`}
            autoFocus
            onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
            rows={3}
            maxLength={2000}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") cancel();
            }}
            className="min-w-0 flex-1 basis-full resize-y rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-[14px] leading-relaxed outline-none"
          />
          <select aria-label="Topic" value={topic} onChange={(e) => setTopic(e.target.value as MemoryCategory)} className={select}>
            {MEMORY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {MEMORY_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
          <span className="ml-auto flex gap-0.5">
            <button type="button" onClick={save} aria-label="Save" className={iconButton}>
              <Check size={14} />
            </button>
            <button type="button" onClick={cancel} aria-label="Cancel" className={iconButton}>
              <X size={14} />
            </button>
          </span>
        </div>
      ) : (
        <p className={`text-[14px] leading-relaxed whitespace-pre-wrap text-fg ${long && !full ? "line-clamp-2" : ""}`}>{m.content}</p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-fg-3">
        {long && !editing ? (
          <button type="button" onClick={() => setFull(!full)} className="font-medium text-fg-2 hover:text-fg">
            {full ? "Less" : "More"}
          </button>
        ) : null}
        <span>{m.scope === "personal" ? "Only me" : "Shared"}</span>
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
            <button type="button" onClick={onShare} aria-label="Share" title="Share" className={iconButton}>
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
              <button type="button" onClick={() => setEditing(true)} aria-label="Edit" title="Edit or move to another topic" className={iconButton}>
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
                {s === "workspace" ? "Shared" : "Only me"}
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

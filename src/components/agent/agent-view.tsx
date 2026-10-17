"use client";

import { AlertCircle, Pencil, Plus, Trash2, X } from "lucide-react";
import { useRef, useState } from "react";
import { formatSize, iconFor } from "@/components/chat/attachments";
import { BusinessBrain } from "@/components/settings/business-brain";
import { SaveRow, Section, input, submitOnModEnter, useWarnUnsaved } from "@/components/settings/section";
import { appName } from "@/lib/apps";
import { ApiError, api, uploadAgentFile } from "@/lib/client/api";
import { TEMPLATES, templateById } from "@/lib/templates";
import {
  ATTACHMENT_TYPES,
  MAX_AGENT_FILES,
  type Attachment,
  type Memory,
  type MemoryPromotion,
  type UsageSummary,
  type WorkspaceSettings,
} from "@/lib/types";

interface Props {
  initialSettings: WorkspaceSettings;
  /** null when memory isn't available (not set up, or couldn't be reached). */
  initialMemories: Memory[] | null;
  /** Set (possibly empty) only when the Brain is on for this account. */
  initialPromotions: MemoryPromotion[] | null;
  usage: UsageSummary;
  canEdit: boolean;
  /** The caller's own files for this agent. */
  initialFiles: Attachment[];
  /** Whether the agent can read files. */
  allowFiles: boolean;
}

async function patchSettings(patch: Partial<WorkspaceSettings>): Promise<WorkspaceSettings> {
  const res = await fetch("/api/workspace/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = (await res.json().catch(() => null)) as { settings?: WorkspaceSettings; error?: string } | null;
  if (!res.ok || !body?.settings) throw new Error(body?.error ?? "Couldn't save. Try again.");
  return body.settings;
}

// Everything about the active agent: who it is, what it knows, and how much it's used.
export function AgentView({ initialSettings, initialMemories, initialPromotions, usage, canEdit, initialFiles, allowFiles }: Props) {
  const [settings, setSettings] = useState(initialSettings);
  return (
    <>
      <AgentName name={settings.name} canEdit={canEdit} onSaved={setSettings} />
      <p className="mt-1 text-[14px] text-fg-3">
        {canEdit ? "What this agent is for and how it works. It reads this before every conversation." : "Only the owner can change this agent."}
      </p>
      <div className="mt-10 space-y-14">
        <AgentSection initial={settings} canEdit={canEdit} onSaved={setSettings} />
        {allowFiles || initialFiles.length > 0 ? <FilesSection initial={initialFiles} allowFiles={allowFiles} /> : null}
        {initialPromotions ? (
          <Section
            title="Brain"
            description="Everything this agent knows about you and its work, by topic. It saves facts as you talk; edit, pin, or remove them here."
          >
            {initialMemories === null ? (
              <p className="text-[13.5px] text-fg-3">Memory isn't available right now.</p>
            ) : (
              <BusinessBrain initialMemories={initialMemories} initialPromotions={initialPromotions} isOwner={canEdit} />
            )}
          </Section>
        ) : (
          <MemorySection initial={initialMemories} isOwner={canEdit} />
        )}
        <Section title="Usage" description="Messages to this agent today.">
          <div className="rounded-xl border border-line bg-surface px-4 py-4">
            <div className="flex items-baseline justify-between text-[14px]">
              <span className="text-fg-2">Today</span>
              <span className="tabular-nums">
                <span className="font-medium">{usage.runsToday}</span>
                <span className="text-fg-3"> / {usage.runsPerDayLimit}</span>
              </span>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-subtle">
              <div
                className="h-full rounded-full bg-fg-2 transition-[width]"
                style={{ width: `${Math.min(100, (usage.runsToday / usage.runsPerDayLimit) * 100)}%` }}
              />
            </div>
            <p className="mt-3 text-[12.5px] text-fg-3">
              Up to {usage.runsPerMinuteLimit} messages a minute per person. Limits reset at midnight UTC.
            </p>
          </div>
        </Section>
        <ChatHistorySection />
      </div>
    </>
  );
}

// The page title doubles as the name field: click it, type, and Enter (or click away) saves.
function AgentName({ name, canEdit, onSaved }: { name: string; canEdit: boolean; onSaved: (settings: WorkspaceSettings) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [shown, setShown] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);
  const title = "font-display text-[30px] leading-tight tracking-[-0.015em]";

  async function commit() {
    setEditing(false);
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const next = draft.trim();
    if (!next || next === shown) {
      setDraft(shown);
      return;
    }
    const previous = shown;
    setShown(next);
    setError(null);
    try {
      const settings = await patchSettings({ name: next });
      setShown(settings.name);
      setDraft(settings.name);
      onSaved(settings);
    } catch (e) {
      setShown(previous);
      setDraft(previous);
      setError((e as Error).message);
    }
  }

  if (!canEdit) return <h1 className={`mt-6 ${title}`}>{shown}</h1>;
  return (
    <div className="mt-6">
      {editing ? (
        <h1>
          <input
            autoFocus
            aria-label="Agent name"
            maxLength={80}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                cancelled.current = true;
                setDraft(shown);
                e.currentTarget.blur();
              }
            }}
            className={`-mx-2 w-[calc(100%+16px)] rounded-lg bg-surface px-2 outline-none ring-1 ring-line-strong ${title}`}
          />
        </h1>
      ) : (
        <h1>
          <button
            type="button"
            onClick={() => setEditing(true)}
            title="Rename"
            className={`group/name -mx-2 flex max-w-[calc(100%+16px)] items-center gap-2.5 rounded-lg px-2 text-left transition-colors hover:bg-hover ${title}`}
          >
            <span className="min-w-0 truncate">{shown}</span>
            <Pencil size={16} className="shrink-0 text-fg-3 opacity-0 transition-opacity group-hover/name:opacity-100 group-focus-visible/name:opacity-100 max-md:opacity-100" />
          </button>
        </h1>
      )}
      {error ? (
        <p role="alert" className="mt-1 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const ACCEPT = Object.keys(ATTACHMENT_TYPES)
  .map((ext) => `.${ext}`)
  .join(",");

// The caller's own files for this agent (a résumé, a price list). Every member has their own
// shelf, so this isn't limited to the owner.
function FilesSection({ initial, allowFiles }: { initial: Attachment[]; allowFiles: boolean }) {
  const [files, setFiles] = useState(initial);
  const [uploads, setUploads] = useState<{ key: string; name: string; error?: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const full = files.length + uploads.filter((u) => !u.error).length >= MAX_AGENT_FILES;

  async function add(list: FileList) {
    setError(null);
    const room = MAX_AGENT_FILES - files.length - uploads.filter((u) => !u.error).length;
    const chosen = [...list].slice(0, Math.max(0, room));
    if (chosen.length < list.length) setError(`This agent can hold up to ${MAX_AGENT_FILES} files.`);
    for (const file of chosen) {
      const key = crypto.randomUUID();
      setUploads((all) => [...all, { key, name: file.name }]);
      try {
        const added = await uploadAgentFile(file);
        setFiles((all) => [...all, added]);
        setUploads((all) => all.filter((u) => u.key !== key));
      } catch (e) {
        const message = e instanceof ApiError ? e.message : "Couldn't upload this file.";
        setUploads((all) => all.map((u) => (u.key === key ? { ...u, error: message } : u)));
      }
    }
  }

  async function remove(id: string) {
    setError(null);
    const previous = files;
    setFiles((all) => all.filter((f) => f.id !== id));
    try {
      await api.deleteAgentFile(id);
    } catch {
      setFiles(previous);
      setError("Couldn't remove that file. Try again.");
    }
  }

  return (
    <Section title="Files" description="Documents this agent reads with every message, in every chat, like your résumé or a price list. Only you see your files.">
      <div className="rounded-xl border border-line bg-surface px-3 py-2">
        {files.length === 0 && uploads.length === 0 ? (
          <p className="px-1 py-1.5 text-[13.5px] text-fg-3">No files yet.</p>
        ) : (
          <ul className="space-y-1">
            {files.map((f) => {
              const Icon = iconFor(f.name, f.mimeType);
              return (
                <li key={f.id} className="group/file flex h-8 items-center gap-2 rounded-lg px-1 text-[13.5px]">
                  <Icon size={15} className="shrink-0 text-fg-3" />
                  <span className="min-w-0 flex-1 truncate text-fg">{f.name}</span>
                  <span className="shrink-0 text-[12px] text-fg-3">{formatSize(f.size)}</span>
                  <button
                    type="button"
                    onClick={() => void remove(f.id)}
                    aria-label={`Remove ${f.name}`}
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-3 opacity-0 transition-opacity group-hover/file:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100 max-md:opacity-100"
                  >
                    <X size={13} />
                  </button>
                </li>
              );
            })}
            {uploads.map((u) => (
              <li key={u.key} className="flex h-8 items-center gap-2 rounded-lg px-1 text-[13.5px]">
                {u.error ? <AlertCircle size={15} className="shrink-0 text-danger" /> : <span className="spinner shrink-0" aria-label="Uploading" />}
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
        {allowFiles ? (
          <div className="mt-1 border-t border-line pt-2">
            <button
              type="button"
              onClick={() => picker.current?.click()}
              disabled={full}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-fg-2 transition-colors hover:bg-hover disabled:opacity-50"
            >
              <Plus size={14} />
              Add files
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              accept={ACCEPT}
              hidden
              aria-label="Add files"
              onChange={(e) => {
                if (e.target.files?.length) void add(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
        ) : null}
      </div>
      {error ? (
        <p role="status" className="mt-2 text-[12.5px] text-danger">
          {error}
        </p>
      ) : null}
      {!allowFiles ? <p className="mt-2 text-[12.5px] text-fg-3">The agent can&apos;t read files yet.</p> : null}
    </Section>
  );
}

function ChatHistorySection() {
  const [state, setState] = useState<"idle" | "confirm" | "clearing" | "cleared">("idle");
  const [error, setError] = useState<string | null>(null);

  async function clear() {
    setState("clearing");
    setError(null);
    try {
      await api.clearConversations();
      setState("cleared");
    } catch (e) {
      setState("confirm");
      setError((e as Error).message || "Couldn't clear your chats. Try again.");
    }
  }

  const button = "h-8 shrink-0 rounded-lg px-3 text-[13px] font-medium transition-opacity disabled:opacity-50";
  return (
    <Section title="Chat history">
      <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-surface px-4 py-3">
        <p className="text-[13.5px] text-fg-2">
          {state === "cleared"
            ? "Your chats with this agent are cleared."
            : state === "idle"
              ? "Delete every chat you've had with this agent, including chats in projects. Projects, their files, and memory stay."
              : "Delete all your chats with this agent? This can't be undone."}
        </p>
        {state === "idle" ? (
          <button type="button" onClick={() => setState("confirm")} className={`${button} border border-line text-danger hover:bg-hover`}>
            Clear history
          </button>
        ) : state === "cleared" ? null : (
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              disabled={state === "clearing"}
              onClick={() => setState("idle")}
              className={`${button} border border-line text-fg-2 hover:bg-hover`}
            >
              Cancel
            </button>
            <button type="button" disabled={state === "clearing"} onClick={() => void clear()} className={`${button} bg-danger text-on-inverse hover:opacity-90`}>
              {state === "clearing" ? "Clearing…" : "Delete all"}
            </button>
          </div>
        )}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-[12.5px] text-danger">
          {error}
        </p>
      ) : null}
    </Section>
  );
}


function AgentSection({ initial, canEdit, onSaved }: { initial: WorkspaceSettings; canEdit: boolean; onSaved: (settings: WorkspaceSettings) => void }) {
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const dirty = draft.profile !== saved.profile || draft.agentInstructions !== saved.agentInstructions;
  const template = templateById(saved.templateId);
  useWarnUnsaved(canEdit && dirty);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!dirty || status === "saving") return;
    setStatus("saving");
    setError(null);
    try {
      // The name is saved from the page title, so leave it out here.
      const settings = await patchSettings({ profile: draft.profile, agentInstructions: draft.agentInstructions });
      setSaved(settings);
      setDraft(settings);
      setStatus("saved");
      onSaved(settings);
    } catch (e) {
      setStatus("error");
      setError((e as Error).message);
    }
  }

  return (
    <Section title="Setup">
      {canEdit ? (
        <TemplatePicker
          current={saved.templateId}
          onApplied={(settings) => {
            setSaved(settings);
            // Keep unsaved edits; take the instructions the template filled in.
            setDraft((d) => ({ ...d, templateId: settings.templateId, agentInstructions: d.agentInstructions || settings.agentInstructions }));
          }}
        />
      ) : null}
      <form onSubmit={save} onKeyDown={submitOnModEnter} className="mt-5 space-y-5">
        <div>
          <label htmlFor="context" className="text-[13px] font-medium text-fg-2">
            What this agent is for
          </label>
          <textarea
            id="context"
            disabled={!canEdit}
            rows={5}
            maxLength={8000}
            value={draft.profile}
            onChange={(e) => setDraft({ ...draft, profile: e.target.value })}
            placeholder={template?.profilePrompt ?? "What you want this agent to help with, a few lines about you, and anything it should always keep in mind."}
            className={`mt-1.5 resize-y py-3 leading-relaxed ${input}`}
          />
        </div>
        <div>
          <label htmlFor="instructions" className="text-[13px] font-medium text-fg-2">
            Instructions for the agent
          </label>
          <textarea
            id="instructions"
            disabled={!canEdit}
            rows={4}
            maxLength={8000}
            value={draft.agentInstructions}
            onChange={(e) => setDraft({ ...draft, agentInstructions: e.target.value })}
            placeholder="Tone, preferences, things to always or never do…"
            className={`mt-1.5 resize-y py-3 leading-relaxed ${input}`}
          />
        </div>
        {canEdit ? <SaveRow dirty={dirty} status={status} error={error} label="Save changes" /> : null}
      </form>
    </Section>
  );
}

function TemplatePicker({ current, onApplied }: { current: string | null; onApplied: (settings: WorkspaceSettings) => void }) {
  const [choice, setChoice] = useState(current ?? TEMPLATES[0].id);
  const [status, setStatus] = useState<"idle" | "applying" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const chosen = templateById(choice);

  async function apply() {
    setStatus("applying");
    setMessage(null);
    const res = await fetch("/api/workspace/template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: choice, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    });
    const body = (await res.json().catch(() => null)) as { settings?: WorkspaceSettings; addedSkills?: number; addedTasks?: number; error?: string } | null;
    if (!res.ok || !body?.settings) {
      setStatus("error");
      setMessage(body?.error ?? "Couldn't apply the template. Try again.");
      return;
    }
    onApplied(body.settings);
    setStatus("idle");
    const added = [
      body.addedSkills ? `${body.addedSkills} skill${body.addedSkills === 1 ? "" : "s"}` : "",
      body.addedTasks ? `${body.addedTasks} paused task${body.addedTasks === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    setMessage(added.length > 0 ? `Applied. Added ${added.join(" and ")}.` : "Applied. Nothing new to add.");
  }

  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="template" className="text-[13px] font-medium text-fg-2">
          Template
        </label>
        <select
          id="template"
          value={choice}
          onChange={(e) => {
            setChoice(e.target.value);
            setMessage(null);
          }}
          className="h-8 rounded-lg border border-line bg-surface px-2 text-[13.5px] text-fg outline-none focus:border-line-strong"
        >
          {TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.id === current ? " (current)" : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void apply()}
          disabled={status === "applying"}
          className="h-8 rounded-lg border border-line px-3 text-[13px] font-medium text-fg-2 transition-colors hover:bg-hover disabled:opacity-50"
        >
          {status === "applying" ? "Applying…" : "Apply"}
        </button>
        <span role="status" className={`text-[12.5px] ${status === "error" ? "text-danger" : "text-fg-3"}`}>
          {message}
        </span>
      </div>
      {chosen ? (
        <p className="mt-2 text-[12.5px] leading-snug text-fg-3">
          {chosen.description} Adds its skills and fills in instructions if they&apos;re empty; never overwrites what you wrote.
          {chosen.apps.length > 0 ? ` Works best with ${chosen.apps.map(appName).join(", ")}.` : ""}
          {chosen.optionalApps?.length ? ` Optional: ${chosen.optionalApps.map(appName).join(", ")}.` : ""}
        </p>
      ) : null}
    </div>
  );
}


function MemorySection({ initial, isOwner }: { initial: Memory[] | null; isOwner: boolean }) {
  const [memories, setMemories] = useState(initial ?? []);
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<Memory["scope"]>("workspace");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!content.trim() || pending) return;
    setPending(true);
    setError(null);
    const res = await fetch("/api/workspace/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, scope }),
    });
    const body = (await res.json().catch(() => null)) as { memory?: Memory; error?: string } | null;
    setPending(false);
    if (!res.ok || !body?.memory) {
      setError(body?.error ?? "Couldn't save that. Try again.");
      return;
    }
    setMemories((list) => [body.memory!, ...list]);
    setContent("");
  }

  async function remove(id: string) {
    const previous = memories;
    setMemories((list) => list.filter((m) => m.id !== id));
    setError(null);
    const res = await fetch(`/api/workspace/memories/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      setMemories(previous);
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Couldn't remove that. Try again.");
    }
  }

  return (
    <Section
      title="Memory"
      description="What this agent knows about you and its work. It saves things as you talk, and you can add or remove them here."
    >
      {initial === null ? (
        <p className="text-[13.5px] text-fg-3">Memory isn't available right now.</p>
      ) : (
        <>
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
        <div className="flex items-center justify-between gap-2 pt-1 pl-1">
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
          <button
            type="submit"
            disabled={!content.trim() || pending}
            className="h-8 rounded-lg bg-inverse px-3 text-[13px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:opacity-30"
          >
            Remember
          </button>
        </div>
      </form>
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {error}
        </p>
      ) : null}

      {memories.length === 0 ? (
        <p className="mt-4 text-[13.5px] text-fg-3">Nothing saved yet. Add something above, or just tell the agent in chat.</p>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {memories.map((m) => (
            <li key={m.id} className="group/memory flex items-start gap-3 py-3">
              <p className="min-w-0 flex-1 text-[14px] leading-relaxed whitespace-pre-wrap text-fg">{m.content}</p>
              {m.scope === "personal" ? (
                <span className="mt-0.5 shrink-0 rounded-full border border-line px-2 py-0.5 text-[11.5px] text-fg-3">Only me</span>
              ) : null}
              {m.mine || isOwner ? (
                <button
                  type="button"
                  onClick={() => remove(m.id)}
                  aria-label="Forget this"
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-3 opacity-0 transition-opacity group-hover/memory:opacity-100 hover:bg-hover hover:text-danger focus-visible:opacity-100 max-md:opacity-100"
                >
                  <Trash2 size={14} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
        </>
      )}
    </Section>
  );
}

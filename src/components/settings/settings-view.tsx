"use client";

import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { appName } from "@/lib/apps";
import { api } from "@/lib/client/api";
import { disablePush, enablePush, pushState, type PushState } from "@/lib/client/push";
import { TEMPLATES, templateById } from "@/lib/templates";
import type { Memory, MemoryPromotion, UsageSummary, WorkspaceSettings } from "@/lib/types";
import { BusinessBrain } from "./business-brain";
import { ConnectionsList } from "./connections-list";

interface Props {
  initialSettings: WorkspaceSettings;
  /** null when memory isn't available (not set up, or couldn't be reached). */
  initialMemories: Memory[] | null;
  /** Set (possibly empty) only when the Brain is on for this account. */
  initialPromotions: MemoryPromotion[] | null;
  usage: UsageSummary;
  canEdit: boolean;
  email: string | null;
  /** The member's personal guardrail, shown read-only; null when they don't have one. */
  guardrail: string | null;
}

const input =
  "w-full rounded-xl border border-line bg-surface px-3.5 text-[14.5px] text-fg outline-none transition-[border-color,box-shadow] placeholder:text-fg-4 focus:border-line-strong focus:shadow-composer focus-visible:outline-none disabled:bg-subtle/50 disabled:text-fg-2";

export function SettingsView({ initialSettings, initialMemories, initialPromotions, usage, canEdit, email, guardrail }: Props) {
  return (
    <div className="mt-10 space-y-14">
      {guardrail ? (
        <Section
          title="Personal guardrail"
          description="On. The agent follows these rules for you everywhere, ahead of any other instructions. They can't be changed here."
        >
          <p className="rounded-xl border border-line bg-subtle/50 px-4 py-3 text-[13.5px] leading-relaxed whitespace-pre-wrap text-fg-2">{guardrail}</p>
        </Section>
      ) : null}
      <AgentSection initial={initialSettings} canEdit={canEdit} />
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
      <Section title="Connected apps" description="Apps the agent can use for you. It asks before changing anything, and only you can use your connections.">
        <ConnectionsList returnTo="/settings" />
      </Section>
      <NotificationsSection />
      <ChatHistorySection />
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
      <Section title="Account">
        <div className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3 text-[14px]">
          <span className="truncate text-fg-2">{email}</span>
          <button
            type="button"
            onClick={() => void api.signOut().finally(() => window.location.assign("/login"))}
            className="text-[13.5px] font-medium text-fg-2 hover:text-fg"
          >
            Sign out
          </button>
        </div>
      </Section>
    </div>
  );
}

const PUSH_NOTES: Record<PushState, string> = {
  unsupported: "This browser can't show notifications.",
  "needs-install": "On iPhone, add Studio to your Home Screen first: tap Share, then Add to Home Screen, and open it from there.",
  unavailable: "Notifications aren't set up on this server yet.",
  denied: "Notifications are blocked for Studio. Allow them in this device's settings, then come back.",
  off: "Get a notification when a task finishes or needs your OK while you're away.",
  on: "You'll get a notification when a task finishes or needs your OK while you're away.",
};

function NotificationsSection() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void pushState().then(setState, () => setState("unsupported"));
  }, []);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      if (state === "on") {
        await disablePush();
        setState("off");
      } else {
        setState(await enablePush());
      }
    } catch (e) {
      setError((e as Error).message || "Couldn't change notifications. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const switchable = state === "on" || state === "off";
  return (
    <Section title="Notifications on this device">
      <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-surface px-4 py-3">
        <p className="text-[13.5px] text-fg-2">{state ? PUSH_NOTES[state] : "Checking…"}</p>
        {switchable ? (
          <button
            type="button"
            role="switch"
            aria-checked={state === "on"}
            aria-label="Notifications on this device"
            disabled={busy}
            onClick={() => void toggle()}
            className={`relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:opacity-60 ${state === "on" ? "bg-fg" : "bg-line-strong"}`}
          >
            <span
              className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-surface shadow-sm transition-transform ${state === "on" ? "translate-x-4" : ""}`}
            />
          </button>
        ) : null}
      </div>
      {error ? <p className="mt-2 text-[12.5px] text-danger">{error}</p> : null}
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

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
      {description ? <p className="mt-1 text-[13.5px] text-fg-3">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function AgentSection({ initial, canEdit }: { initial: WorkspaceSettings; canEdit: boolean }) {
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const dirty = draft.name !== saved.name || draft.profile !== saved.profile || draft.agentInstructions !== saved.agentInstructions;
  const template = templateById(saved.templateId);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setStatus("saving");
    setError(null);
    const res = await fetch("/api/workspace/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    const body = (await res.json().catch(() => null)) as { settings?: WorkspaceSettings; error?: string } | null;
    if (!res.ok || !body?.settings) {
      setStatus("error");
      setError(body?.error ?? "Couldn't save. Try again.");
      return;
    }
    setSaved(body.settings);
    setDraft(body.settings);
    setStatus("saved");
  }

  return (
    <Section
      title="Agent"
      description={canEdit ? "The agent reads this before every conversation." : "Only the owner can change these."}
    >
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
      <form onSubmit={save} className="mt-5 space-y-5">
        <div>
          <label htmlFor="name" className="text-[13px] font-medium text-fg-2">
            Agent name
          </label>
          <input
            id="name"
            disabled={!canEdit}
            maxLength={80}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className={`mt-1.5 h-10 ${input}`}
          />
        </div>
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
        {canEdit ? (
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={!dirty || status === "saving" || !draft.name.trim()}
              className="h-9 rounded-lg bg-inverse px-3.5 text-[13.5px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:opacity-30"
            >
              {status === "saving" ? "Saving…" : "Save changes"}
            </button>
            <span role="status" className={`text-[13px] ${status === "error" ? "text-danger" : "text-fg-3"}`}>
              {status === "saved" && !dirty ? "Saved" : status === "error" ? error : ""}
            </span>
          </div>
        ) : null}
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

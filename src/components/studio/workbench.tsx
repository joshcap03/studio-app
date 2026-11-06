"use client";

import { History, RefreshCw, SquarePen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/client/api";
import { loadStudio, type StudioData, type StudioTask } from "@/lib/client/studio";
import { missingApps, nextStep, partPath, partsNeeding, PART_LABELS, STUDIO_PARTS, type NextAction, type StudioPart, type StudioSignals } from "@/lib/studio";
import { toolkitForApp } from "@/lib/apps";
import { TEACH_SKILL_ID } from "@/lib/skills/teach";
import { templateById } from "@/lib/templates";
import type { Companion, MessageSkill, SetupSummary, WorkspaceSkill, WorkspaceSummary } from "@/lib/types";
import { primaryAsk, secondaryAsk } from "./ask-link";
import { AppsPart } from "./parts/apps";
import { BriefPart } from "./parts/brief";
import { HistoryPart } from "./parts/history";
import { KnowledgePart } from "./parts/knowledge";
import { RoutinesPart } from "./parts/routines";
import { SkillsPart } from "./parts/skills";

// The agent's workbench in Studio ("/studio", the "studio" preview), where a creator shapes an agent
// and tries it in the same view: its parts (the rack), the editor for the one picked (the bench), and
// the real agent beside them (Try it). What's saved is live on the next reply, since every run reads
// the agent as it is. Each part can be edited directly or described in words, which go to the Try
// pane's message box, unsent. Nothing here is invented: a part that can't be read says so.

interface Props {
  workspace: WorkspaceSummary;
  /** Home exists for this member: several agents, with the preview on. */
  several: boolean;
  /** Who the agent is to them, as the shell has it (a preview); the page asks again for the latest. */
  companion: Companion | null;
  /** The owner's setup interview; null for other members. */
  setup: SetupSummary | null;
  /** The skills the composer offers, built-ins included ("Show me once" among them where there's a browser). */
  skills: WorkspaceSkill[];
  hasChats: boolean;
  part: StudioPart;
  /** How this device writes its modifier key ("⌘" or "Ctrl+"). */
  mod: string;
  /** Goes up when a reply may have changed the agent (an applied proposal). */
  fresh: number;
  onGo: (path: string) => void;
  /** Puts words (null: leaves the draft alone) and a skill in the Try pane's message box, unsent. */
  onDescribe: (text: string | null, skill?: MessageSkill | null) => void;
  onFocusTry: () => void;
  /** Clears the Try pane for a fresh chat; null when it's clear. */
  onNewTry: (() => void) | null;
  /** Sends the last ask again in a fresh try; null when there's nothing to ask again, or it's working. */
  onAskAgain: (() => void) | null;
  /** The agent's own skills changed; the composer's list follows. */
  onSkills: (skills: WorkspaceSkill[]) => void;
  tryPane: ReactNode;
  onSetup: () => void;
  onSayHello: () => void;
  /** Puts the agent on Home or takes it off (the owner's call). */
  onOnHome: (on: boolean) => Promise<void>;
}

export function Workbench(props: Props) {
  const { workspace, several, companion: shellCompanion, setup, skills, hasChats, part, mod, fresh, onGo, onDescribe, onFocusTry, onNewTry, onAskAgain, onSkills, tryPane, onSetup, onSayHello, onOnHome } = props;
  const [data, setData] = useState<StudioData | null>(null);
  /** Goes up when the agent changed from outside an editor (a restore, an applied proposal): they start again from what's saved. */
  const [epoch, setEpoch] = useState(0);
  /** On narrower screens one pane shows at a time. */
  const [view, setView] = useState<"build" | "try">("build");
  const saveNow = useRef<(() => void) | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadStudio(controller.signal).then(
      (next) => {
        if (!controller.signal.aborted) setData(next);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [workspace.id]);

  const reload = useCallback(async () => {
    const next = await loadStudio(new AbortController().signal).catch(() => null);
    if (!next) return;
    setData(next);
    setEpoch((n) => n + 1);
    if (next.skills) onSkills(next.skills);
  }, [onSkills]);

  const seenFresh = useRef(fresh);
  useEffect(() => {
    if (seenFresh.current === fresh) return;
    seenFresh.current = fresh;
    void reload();
  }, [fresh, reload]);

  const owner = (data?.role ?? workspace.role) === "owner";
  const companion = data?.companion ?? shellCompanion;
  const template = templateById(data?.settings?.templateId);
  const toolkits = useMemo(() => (data?.connections?.configured ? data.connections.toolkits : []), [data?.connections]);
  /** The apps its template was made for, as Composio slugs; the rest on offer are Settings' business. */
  const suggested = useMemo(() => [...(template?.apps ?? []), ...(template?.optionalApps ?? [])].map(toolkitForApp).filter((slug): slug is string => Boolean(slug)), [template]);
  const signals: StudioSignals = {
    setup: owner ? (setup?.status ?? null) : null,
    companion: companion?.stage ?? null,
    missingApps: missingApps(toolkits, suggested),
    hasChats,
    onHome: workspace.onHome,
    several,
    owner,
  };
  const needs = partsNeeding(signals);
  const parts = STUDIO_PARTS.filter((p) => p !== "history" || owner);

  const describe = useCallback(
    (text: string | null, skill?: MessageSkill | null) => {
      setView("try");
      onDescribe(text, skill);
    },
    [onDescribe],
  );

  // Keys of a tool: Alt+number picks a part, Cmd+S saves now, Cmd+J goes to the Try pane, and
  // Cmd+Shift+Enter asks again. Alt is matched by the physical key, since on a Mac it types a symbol.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const modKey = event.metaKey || event.ctrlKey;
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (event.altKey && !modKey && digit) {
        const next = parts[Number(digit) - 1];
        if (next) {
          event.preventDefault();
          saveNow.current?.();
          setView("build");
          onGo(partPath(next));
        }
      } else if (modKey && !event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveNow.current?.();
      } else if (modKey && !event.shiftKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setView("try");
        requestAnimationFrame(onFocusTry);
      } else if (modKey && event.shiftKey && event.key === "Enter" && onAskAgain) {
        // Before the message box, where Shift+Enter is a new line.
        event.preventDefault();
        event.stopPropagation();
        saveNow.current?.();
        setView("try");
        onAskAgain();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [parts, onGo, onFocusTry, onAskAgain]);

  const alt = mod === "⌘" ? "⌥" : "Alt+";
  const count = (p: StudioPart): number | null => {
    if (!data) return null;
    if (p === "skills") return data.skills?.length ?? null;
    if (p === "knowledge") return data.memories?.length ?? null;
    if (p === "apps") return toolkits.filter((t) => t.status === "connected").length;
    if (p === "routines") return data.tasks?.filter((t) => t.status !== "archived").length ?? null;
    return null;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav aria-label="Parts of this agent" className="flex shrink-0 flex-col gap-0.5 border-line px-2 pb-2 max-md:border-b md:w-[150px] md:border-r md:pt-1">
        <ul className="flex gap-0.5 overflow-x-auto [scrollbar-width:none] md:flex-col md:overflow-visible">
          {parts.map((p, i) => (
            <li key={p} className="shrink-0">
              <a
                href={partPath(p)}
                aria-current={part === p ? "page" : undefined}
                title={`${PART_LABELS[p]} (${alt}${i + 1})`}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  saveNow.current?.();
                  setView("build");
                  onGo(partPath(p));
                }}
                className={`flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13.5px] transition-colors ${part === p ? "bg-press font-medium text-fg" : "text-fg-2 hover:bg-hover hover:text-fg"}`}
              >
                {p === "history" ? <History size={14} className="shrink-0 text-fg-3" aria-hidden="true" /> : null}
                <span className="min-w-0 flex-1 truncate">{PART_LABELS[p]}</span>
                {needs.includes(p) ? <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label="Needs something" /> : null}
                {count(p) !== null ? <span className="shrink-0 text-[11.5px] font-normal tabular-nums text-fg-4">{count(p)}</span> : null}
              </a>
            </li>
          ))}
        </ul>
        <p className="mt-auto hidden px-2.5 pb-1 text-[11px] leading-relaxed text-fg-4 md:block">
          {alt}1–{parts.length} parts
          <br />
          {mod}J try it
        </p>
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div role="group" aria-label="Build or try" className="mx-3 my-2 grid shrink-0 grid-cols-2 gap-0.5 rounded-[10px] bg-press p-0.5 xl:hidden">
          {(["build", "try"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`h-7 rounded-lg text-[13px] font-medium transition-colors ${view === v ? "bg-surface text-fg shadow-sm" : "text-fg-3 hover:text-fg"}`}
            >
              {v === "build" ? "Build" : "Try it"}
            </button>
          ))}
        </div>

        <div className="flex min-h-0 flex-1">
          <section aria-label={PART_LABELS[part]} className={`scroll-quiet min-w-0 flex-1 overflow-y-auto px-4 md:px-6 ${view === "try" ? "max-xl:hidden" : ""}`}>
            <div className="mx-auto w-full max-w-[42rem] pt-1 pb-[max(24px,env(safe-area-inset-bottom))]">
              {data ? (
                <div key={part} className="animate-fade-up">
                  <NextMove
                    signals={signals}
                    onSetup={onSetup}
                    onSayHello={onSayHello}
                    onChat={() => {
                      setView("try");
                      requestAnimationFrame(onFocusTry);
                    }}
                    onOnHome={onOnHome}
                  />
                  {part === "brief" ? (
                    <BriefPart
                      key={epoch}
                      settings={data.settings}
                      owner={owner}
                      template={template}
                      several={several}
                      onHome={workspace.onHome}
                      onOnHome={onOnHome}
                      saveNow={saveNow}
                      onDescribe={describe}
                      onSaved={(settings) => setData((d) => (d ? { ...d, settings } : d))}
                      onSetup={onSetup}
                    />
                  ) : part === "skills" ? (
                    <SkillsPart
                      key={epoch}
                      skills={data.skills}
                      teach={skills.find((s) => s.id === TEACH_SKILL_ID) ?? null}
                      owner={owner}
                      saveNow={saveNow}
                      onDescribe={describe}
                      onChange={(own) => {
                        setData((d) => (d ? { ...d, skills: own } : d));
                        onSkills(own);
                      }}
                    />
                  ) : part === "knowledge" ? (
                    <KnowledgePart key={epoch} data={data} owner={owner} onGo={onGo} onDescribe={describe} />
                  ) : part === "apps" ? (
                    <AppsPart connections={data.connections} allowed={data.allowed} suggested={suggested} onDescribe={describe} />
                  ) : part === "routines" ? (
                    <RoutinesPart
                      tasks={data.tasks}
                      skills={skills}
                      collections={data.library?.trackers.map((t) => t.collection) ?? []}
                      owner={owner}
                      onGo={onGo}
                      onDescribe={describe}
                      onTasks={(tasks: StudioTask[]) => setData((d) => (d ? { ...d, tasks } : d))}
                    />
                  ) : (
                    <HistoryPart settings={data.settings} skills={data.skills} owner={owner} onRestored={reload} />
                  )}
                </div>
              ) : (
                <div aria-busy="true" aria-label="Loading" className="animate-fade-in space-y-3 pt-2 [animation-delay:200ms]">
                  <div className="h-40 animate-pulse rounded-xl bg-subtle/60" />
                  <div className="h-40 animate-pulse rounded-xl bg-subtle/60" />
                </div>
              )}
            </div>
          </section>

          {/* Stays mounted when hidden, so the message box is always there to put words in. */}
          <section aria-label="Try it" className={`min-h-0 min-w-0 flex-col border-line xl:flex xl:w-[420px] xl:shrink-0 xl:border-l ${view === "build" ? "hidden" : "flex flex-1 xl:flex-none"}`}>
            <div className="flex shrink-0 items-center gap-1.5 px-4 pt-1 pb-2">
              <div className="min-w-0 flex-1">
                <h2 className="text-[13px] font-medium text-fg">Try it</h2>
                <p className="truncate text-[12px] text-fg-3">The real agent, with your real apps.</p>
              </div>
              {onAskAgain ? (
                <button
                  type="button"
                  title={`Ask the same thing in a fresh try (${mod}⇧↵)`}
                  onClick={() => {
                    saveNow.current?.();
                    onAskAgain();
                  }}
                  className={secondaryAsk}
                >
                  <RefreshCw size={13} aria-hidden="true" />
                  Ask again
                </button>
              ) : null}
              {onNewTry ? (
                <button type="button" aria-label="New try" title="New try" onClick={onNewTry} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-hover hover:text-fg">
                  <SquarePen size={15} strokeWidth={1.75} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <div className="flex min-h-0 flex-1 flex-col">{tryPane}</div>
          </section>
        </div>
      </div>
    </div>
  );
}

/** The one thing that would help most, while there is one. */
function NextMove({ signals, onSetup, onSayHello, onChat, onOnHome }: { signals: StudioSignals; onSetup: () => void; onSayHello: () => void; onChat: () => void; onOnHome: (on: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const step = nextStep(signals);
  if (!step.action) return null;

  async function act(action: NextAction) {
    switch (action.kind) {
      case "setup":
        return onSetup();
      case "hello":
        return onSayHello();
      case "chat":
        return onChat();
      case "home":
        setBusy(true);
        return onOnHome(true).finally(() => setBusy(false));
      case "connect":
        setBusy(true);
        setError(null);
        try {
          window.location.assign((await api.connectApp(action.slug, "/studio")).url);
        } catch {
          setError("Couldn't start connecting. Try again.");
          setBusy(false);
        }
    }
  }

  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-surface px-4 py-3">
      <p className="min-w-0 flex-1 text-[14px] leading-snug text-fg">{error ?? step.text}</p>
      <button type="button" disabled={busy} onClick={() => void act(step.action!)} className={`${primaryAsk} disabled:opacity-50`}>
        {busy ? "Opening…" : step.action.label}
      </button>
    </div>
  );
}

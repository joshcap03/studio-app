"use client";

import { Check, ChevronRight } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { AppGlyph } from "@/components/chat/app-glyph";
import { formatWhen } from "@/components/tasks/shared";
import { Companion as CompanionMark } from "@/components/ui/companion";
import { JourneyBar } from "@/components/ui/journey";
import { OnHomeSwitch } from "@/components/ui/on-home-switch";
import { appForToolkit, toolkitForApp } from "@/lib/apps";
import { api } from "@/lib/client/api";
import { loadStudio, type StudioData, type StudioTask } from "@/lib/client/studio";
import { TEACH_SKILL_ID } from "@/lib/skills/teach";
import { ASKS, approvalsLine, firstLine, knowledge, knowledgeLine, missingApps, nextStep, readiness, skillOrigin, type NextAction, type StudioSignals } from "@/lib/studio";
import { templateById } from "@/lib/templates";
import type { Companion, ConversationSummary, SetupSummary, WorkspaceSkill, WorkspaceSummary } from "@/lib/types";
import { Ask, primaryAsk, quietLink } from "./ask-link";
import { RoutineRow } from "./routine-row";

// The agent's own page in Studio ("/studio", the "studio" preview): the agent describing itself,
// part by part, from what the app stores and sends it on every run. What it reads before every
// reply, what it knows, what it can do, the jobs it knows how to do, what it does on its own, and
// how it's been lately. Every primary action is a sentence the member finishes in a new chat (see
// ask-link.tsx); the raw forms stay one click deeper, on the pages that already have them. Nothing
// here is invented: a part that can't be read says so.

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
  conversations: ConversationSummary[];
  /** The shell's navigation, for pages inside it and for asks ("/new?ask=…"). */
  onGo: (path: string) => void;
  onSetup: () => void;
  onSayHello: () => void;
  onNewChat: () => void;
  /** Puts the agent on Home or takes it off (the owner's call). */
  onOnHome: (on: boolean) => Promise<void>;
}

export function StudioView({ workspace, several, companion: shellCompanion, setup, skills, conversations, onGo, onSetup, onSayHello, onNewChat, onOnHome }: Props) {
  const [data, setData] = useState<StudioData | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    loadStudio(controller.signal).then(
      (next) => {
        if (!controller.signal.aborted) setData(next);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [workspace.id]);

  const owner = (data?.role ?? workspace.role) === "owner";
  const companion = data?.companion ?? shellCompanion;
  const name = companion?.name ?? data?.settings?.name ?? workspace.name;

  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-4 md:px-8">
      <div className="mx-auto w-full max-w-[56rem] pt-6 pb-[max(24px,env(safe-area-inset-bottom))] md:pt-[5vh]">
        {data ? (
          <Page data={data} name={name} owner={owner} companion={companion} workspace={workspace} several={several} setup={setup} skills={skills} conversations={conversations} onGo={onGo} onSetup={onSetup} onSayHello={onSayHello} onNewChat={onNewChat} onOnHome={onOnHome} onTasks={(tasks) => setData({ ...data, tasks })} />
        ) : (
          <div aria-busy="true" aria-label={`Loading ${name}`} className="animate-fade-in [animation-delay:200ms]">
            <div className="h-16 w-2/3 animate-pulse rounded-xl bg-subtle/60" />
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-40 animate-pulse rounded-xl bg-subtle/60" />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Page({
  data,
  name,
  owner,
  companion,
  workspace,
  several,
  setup,
  skills,
  conversations,
  onGo,
  onSetup,
  onSayHello,
  onNewChat,
  onOnHome,
  onTasks,
}: Props & { data: StudioData; name: string; owner: boolean; onTasks: (tasks: StudioTask[]) => void }) {
  const settings = data.settings;
  const template = templateById(settings?.templateId);
  const toolkits = data.connections?.configured ? data.connections.toolkits : [];
  /** The apps its template was made for, as Composio slugs; the rest on offer are Settings' business. */
  const suggested = [...(template?.apps ?? []), ...(template?.optionalApps ?? [])].map(toolkitForApp).filter((slug): slug is string => Boolean(slug));
  /** What it can do: the apps the member connected, and the template's it still wants. */
  const shown = toolkits.filter((t) => t.status === "connected" || suggested.includes(t.slug));
  const onHome = workspace.onHome;
  const signals: StudioSignals = {
    setup: owner ? (setup?.status ?? null) : null,
    companion: companion?.stage ?? null,
    missingApps: missingApps(toolkits, suggested),
    hasChats: conversations.length > 0,
    onHome,
    several,
    owner,
  };
  const step = nextStep(signals);
  const rail = readiness(signals);
  const [homeBusy, setHomeBusy] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  async function connect(slug: string) {
    setConnecting(slug);
    setConnectError(null);
    try {
      window.location.assign((await api.connectApp(slug, "/studio")).url);
    } catch {
      setConnectError("Couldn't start connecting. Try again.");
      setConnecting(null);
    }
  }

  function act(action: NextAction) {
    switch (action.kind) {
      case "setup":
        return onSetup();
      case "connect":
        return void connect(action.slug);
      case "hello":
        return onSayHello();
      case "chat":
        return onNewChat();
      case "home":
        return void toggleHome();
    }
  }

  async function toggleHome() {
    setHomeBusy(true);
    try {
      await onOnHome(!onHome);
    } finally {
      setHomeBusy(false);
    }
  }

  const teach = skills.find((s) => s.id === TEACH_SKILL_ID);
  const collections = data.library?.trackers.map((t) => t.collection) ?? [];
  const tasks = [...(data.tasks ?? [])].filter((t) => t.status !== "archived").sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
  const lastRunAt = tasks.reduce<number | null>((max, t) => (t.lastRunAt !== null && (max === null || t.lastRunAt > max) ? t.lastRunAt : max), null);
  const facts = data.memories ? knowledge(data.memories) : null;

  return (
    <div className="animate-fade-up">
      {/* Who it is */}
      <header className="flex flex-wrap items-start gap-4">
        {companion ? (
          <CompanionMark stage={companion.stage} look={companion.look} size={56} present="home" className="mt-0.5 shrink-0" />
        ) : (
          <span aria-hidden="true" className="mt-0.5 size-14 shrink-0 rounded-2xl bg-inverse" />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-[28px] leading-tight tracking-[-0.015em] text-fg md:text-[32px]">{name}</h1>
          <p className="mt-1 text-[14px] leading-relaxed text-fg-3">
            I&apos;m {name}, your agent. {template && template.id !== "blank" ? `I started from ${template.name}.` : "I started from scratch."}{" "}
            <a href="/agent" className="text-fg-3 underline decoration-line underline-offset-2 hover:text-fg">
              Rename me or change my voice
            </a>
          </p>
        </div>
        {owner && several ? (
          <label className="flex items-center gap-2.5 text-[13px] font-medium text-fg-2 max-sm:basis-full">
            On Home
            <OnHomeSwitch on={onHome} busy={homeBusy} onToggle={() => void toggleHome()} label={`On Home: ${name}`} />
          </label>
        ) : null}
      </header>

      {/* How far along it is, and the one thing that would help most */}
      <div className="mt-6">
        <JourneyBar steps={rail} still />
        <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11.5px] text-fg-4" aria-hidden="true">
          {rail.map((s) => (
            <li key={s.text} className={s.status === "done" ? "text-fg-3" : ""}>
              {s.text}
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-[15px] leading-relaxed text-fg">{step.text}</p>
          {step.action ? (
            <button type="button" disabled={connecting !== null || homeBusy} onClick={() => act(step.action!)} className={`${primaryAsk} disabled:opacity-50`}>
              {connecting && step.action.kind === "connect" ? "Opening…" : step.action.label}
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        {/* What it reads */}
        <Card title="Before every reply I read this">
          <Reads profile={settings?.profile ?? null} instructions={settings?.agentInstructions ?? null} unread={!settings} onGo={onGo} />
          <Actions>
            <Ask text={ASKS.profile} onGo={onGo}>
              Change what I&apos;m for
            </Ask>
            {owner ? (
              <a href="/agent" className={quietLink}>
                Edit the text myself
              </a>
            ) : null}
          </Actions>
        </Card>

        {/* What it knows */}
        <Card title="What I know">
          <p className="mt-2 text-[14px] leading-relaxed text-fg-2">{facts ? knowledgeLine(facts) : "I couldn't read my notes just now."}</p>
          {facts && facts.topics.length > 0 ? (
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {facts.topics.slice(0, 5).map((t) => (
                <li key={t.category} className="rounded-full bg-subtle px-2.5 py-0.5 text-[12.5px] text-fg-2">
                  {t.label} · {t.count}
                </li>
              ))}
            </ul>
          ) : null}
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-fg-3">
            {data.files ? <li>{count(data.files.length, "file")} you gave me</li> : null}
            {data.library ? (
              <li>
                <Go path="/library" onGo={onGo}>
                  {count(data.library.items.length, "thing")} in the Library
                </Go>
              </li>
            ) : null}
            {data.library ? (
              <li>
                <Go path="/library" onGo={onGo}>
                  {count(data.library.trackers.length, "list")} I keep
                </Go>
              </li>
            ) : null}
          </ul>
          <Actions>
            <Ask text={ASKS.remember} onGo={onGo}>
              Tell me something to remember
            </Ask>
            <a href="/agent" className={quietLink}>
              See everything
            </a>
          </Actions>
        </Card>

        {/* What it can do */}
        <Card title="What I can do">
          {data.connections === null ? (
            <p className="mt-2 text-[14px] leading-relaxed text-fg-2">I couldn&apos;t check your apps just now.</p>
          ) : !data.connections.configured ? (
            <p className="mt-2 text-[14px] leading-relaxed text-fg-2">Connected apps aren&apos;t available here yet.</p>
          ) : shown.length === 0 ? (
            <p className="mt-2 text-[14px] leading-relaxed text-fg-2">No apps yet. Ask me to use one, and I&apos;ll give you a link to connect it.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line">
              {[...shown]
                .sort((a, b) => Number(b.status === "connected") - Number(a.status === "connected"))
                .map((t) => (
                  <li key={t.slug} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                    <AppGlyph app={appForToolkit(t.slug)} size={18} />
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg">{t.name}</span>
                    {t.status === "connected" ? (
                      <Check size={15} className="text-success" aria-label="Connected" />
                    ) : t.status === "pending" ? (
                      <span className="text-[12.5px] text-fg-3">Not finished</span>
                    ) : (
                      <button type="button" disabled={connecting !== null} onClick={() => void connect(t.slug)} className={`${quietLink} text-fg-2 disabled:opacity-50`}>
                        {connecting === t.slug ? "Opening…" : "Connect"}
                      </button>
                    )}
                  </li>
                ))}
            </ul>
          )}
          {connectError ? <p className="mt-2 text-[12.5px] text-danger">{connectError}</p> : null}
          <p className="mt-3 text-[13px] leading-relaxed text-fg-3">{approvalsLine(data.allowed ?? [])}</p>
          <Actions>
            <Ask text={ASKS.app} onGo={onGo}>
              Use another app for me
            </Ask>
            <a href="/settings" className={quietLink}>
              Manage in Settings
            </a>
          </Actions>
        </Card>

        {/* Skills */}
        <Card title="Things I know how to do">
          {data.skills === null ? (
            <p className="mt-2 text-[14px] leading-relaxed text-fg-2">I couldn&apos;t read my skills just now.</p>
          ) : data.skills.length === 0 ? (
            <p className="mt-2 text-[14px] leading-relaxed text-fg-2">Only the basics so far. Teach me a job once and I&apos;ll remember how.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line">
              {data.skills.slice(0, 6).map((s) => (
                <li key={s.id} className="flex items-baseline gap-3 py-2 first:pt-0 last:pb-0">
                  <span className="shrink-0 font-mono text-[13px] text-fg-4" aria-hidden="true">
                    /
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg">{s.name}</span>
                  <span className="shrink-0 text-[12px] text-fg-4">{skillOrigin(s)}</span>
                </li>
              ))}
              {data.skills.length > 6 ? <li className="pt-2 text-[12.5px] text-fg-4">and {data.skills.length - 6} more</li> : null}
            </ul>
          )}
          <Actions>
            <Ask text={teach ? "Show me once: watch me do this job, then write it up as a skill. " : ASKS.skill} skillId={teach?.id} onGo={onGo}>
              Teach me something new
            </Ask>
            <a href="/skills" className={quietLink}>
              See all
            </a>
          </Actions>
        </Card>
      </div>

      {/* Routines */}
      <Card title="What I do on my own" className="mt-4">
        {data.tasks === null ? (
          <p className="mt-2 text-[14px] leading-relaxed text-fg-2">I couldn&apos;t read my routines just now.</p>
        ) : tasks.length === 0 ? (
          <p className="mt-2 text-[14px] leading-relaxed text-fg-2">Nothing yet. Tell me what to do while you&apos;re away and I&apos;ll suggest a routine, with a time and what I&apos;ll keep.</p>
        ) : (
          <ul className="mt-4 divide-y divide-line">
            {tasks.slice(0, 6).map((t) => (
              <RoutineRow key={t.id} task={t} skills={skills} collections={collections} owner={owner} onGo={onGo} onOpen={(id) => onGo(`/tasks/${id}`)} onChanged={(next) => onTasks((data.tasks ?? []).map((x) => (x.id === next.id ? next : x)))} />
            ))}
          </ul>
        )}
        <Actions>
          <Ask text={ASKS.routine} onGo={onGo}>
            Tell me what to do while you&apos;re away
          </Ask>
          <Go path="/tasks" onGo={onGo} className={quietLink}>
            See all
          </Go>
        </Actions>
      </Card>

      {/* Lately */}
      <Card title="Lately" className="mt-4">
        <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[14px] leading-relaxed text-fg-2">
          <li>{conversations.length === 0 ? "No chats with you yet." : `${count(conversations.length, "chat")} with you.`}</li>
          {lastRunAt !== null ? <li>Last ran on my own {lately(lastRunAt)}.</li> : tasks.length > 0 ? <li>I haven&apos;t run on my own yet.</li> : null}
          {data.library && data.library.items.filter((i) => i.pinned).length > 0 ? <li>{count(data.library.items.filter((i) => i.pinned).length, "thing")} you pinned in the Library.</li> : null}
        </ul>
      </Card>
    </div>
  );
}

/** Active routines first, then paused ones waiting to be started, then the rest. */
function rank(task: StudioTask): number {
  return task.status === "active" ? 0 : task.status === "paused" ? 1 : 2;
}

/** "today, 8:02 AM" or "on Oct 3, 8:02 AM", to finish "Last ran on my own …". */
function lately(ms: number): string {
  const when = formatWhen(ms);
  return /^(Today|Tomorrow|Yesterday)/.test(when) ? when.charAt(0).toLowerCase() + when.slice(1) : `on ${when}`;
}

function count(n: number, noun: string): string {
  return n === 1 ? `1 ${noun}` : `${n} ${noun}s`;
}

function Card({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-xl border border-line bg-surface p-5 ${className}`}>
      <h2 className="font-display text-[19px] leading-tight tracking-[-0.01em] text-fg">{title}</h2>
      {children}
    </section>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">{children}</div>;
}

/** A link to a page inside the shell, taken in place. */
function Go({ path, onGo, className = "", children }: { path: string; onGo: (path: string) => void; className?: string; children: ReactNode }) {
  return (
    <a
      href={path}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onGo(path);
      }}
      className={className || "underline decoration-line underline-offset-2 hover:text-fg"}
    >
      {children}
    </a>
  );
}

/**
 * The profile as prose (the member's words, folded after a few lines), and under it, folded, how
 * the agent was set up to work (its template's instructions, read-only: changing them is an ask, so
 * nothing about how it keeps its lists breaks by accident).
 */
function Reads({ profile, instructions, unread, onGo }: { profile: string | null; instructions: string | null; unread: boolean; onGo: (path: string) => void }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(false);
  if (unread) return <p className="mt-2 text-[14px] leading-relaxed text-fg-2">I couldn&apos;t read this just now.</p>;
  const long = (profile ?? "").split("\n").length > 6 || (profile ?? "").length > 480;
  return (
    <div className="mt-2">
      {profile ? (
        <>
          <p className={`whitespace-pre-wrap text-[14px] leading-relaxed text-fg-2 [overflow-wrap:anywhere] ${all ? "" : "line-clamp-6"}`}>{profile}</p>
          {long ? (
            <button type="button" onClick={() => setAll((v) => !v)} className={`mt-1 ${quietLink}`}>
              {all ? "Show less" : "Read all"}
            </button>
          ) : null}
        </>
      ) : (
        <p className="text-[14px] leading-relaxed text-fg-2">You haven&apos;t told me what I&apos;m for yet. Set up with me, or just tell me.</p>
      )}
      {instructions ? (
        <div className="mt-3 rounded-lg border border-line">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-medium text-fg-2 transition-colors hover:text-fg"
          >
            <ChevronRight size={14} className={`shrink-0 text-fg-4 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">…and how I was set up to work{!open && firstLine(instructions) ? `: ${firstLine(instructions)}` : ""}</span>
          </button>
          {open ? (
            <div className="border-t border-line px-3 py-3">
              <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-fg-2 [overflow-wrap:anywhere]">{instructions}</pre>
              <div className="mt-3">
                <Ask text={ASKS.instructions} onGo={onGo} tone="quiet">
                  Ask me to change this
                </Ask>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

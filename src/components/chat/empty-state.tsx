"use client";

import { ArrowRight, AudioLines, CalendarDays, Inbox, LibraryBig, Search, Sheet, Sparkles, type LucideIcon } from "lucide-react";
import { forwardRef, useEffect, useState } from "react";
import { Companion, companionHint, useCompanion } from "@/components/ui/companion";
import { JourneyBar } from "@/components/ui/journey";
import { stepName } from "@/lib/setup-words";
import type { SetupSummary, WorkspaceSkill } from "@/lib/types";
import type { VoiceStatus } from "@/lib/voice/types";
import { Composer, type ComposerHandle, type MessageExtras } from "./composer";

interface Suggestion {
  icon: LucideIcon;
  label: string;
  /** Sent immediately. */
  prompt?: string;
  /** Placed in the composer for the user to finish. */
  prefill?: string;
}

const SUGGESTIONS: Suggestion[] = [
  { icon: Inbox, label: "Triage my inbox", prompt: "Go through my recent email. Tell me what needs a reply and draft the easy ones." },
  { icon: CalendarDays, label: "Prep my week", prompt: "Look at my calendar for this week and tell me what I should prepare for." },
  { icon: Search, label: "Research a competitor", prefill: "Research this competitor and summarize their pricing and positioning: " },
  { icon: Sheet, label: "Build a spreadsheet", prefill: "Build a spreadsheet of " },
];

interface Props {
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: (text: string, extras?: Partial<MessageExtras>) => void;
  /** The workspace's skills; when there are any, they replace the generic suggestions. */
  skills: WorkspaceSkill[];
  /** A skill to attach on load (from "Use" on the skills page). */
  initialSkillId: string | null;
  canManageSkills: boolean;
  allowFiles: boolean;
  footnote: React.ReactNode;
  /** The owner's setup, while it isn't done or set aside: offered above the composer. */
  setup?: SetupSummary | null;
  agentName?: string;
  /** What the member goes by, for the greeting. */
  member?: string | null;
  /** The voice's name, when the member has calls. */
  greeter?: string | null;
  onSetup?: () => void;
  onSkipSetup?: () => void;
  /** Present when the member can do the setup on a call ("Talk it through"). */
  onTalk?: () => void;
  /** A call is being started. */
  talking?: boolean;
  /** Why a call couldn't start. */
  talkNotice?: string | null;
  /** Present once the agent knows the member well enough to introduce itself. */
  onSayHello?: () => void;
  /** Voice for this member, for the message box's mic. */
  voice?: VoiceStatus | null;
  /** A call with the agent from the message box, for a new chat ("Call Rowan"). */
  call?: { label: string; onCall: () => void; busy?: boolean };
}

const chip =
  "inline-flex h-8 items-center gap-2 rounded-full border border-line px-3 text-[13px] text-fg-2 transition-colors hover:border-line-strong hover:bg-surface hover:text-fg";
const SHOWN_SKILLS = 5;

/** The skills offered as chips: the agent's own first (what it's for), then the built-ins every agent has. */
export function chipSkills(skills: WorkspaceSkill[]): WorkspaceSkill[] {
  const builtin = (s: WorkspaceSkill) => s.id.startsWith("builtin:");
  return [...skills.filter((s) => !builtin(s)), ...skills.filter(builtin)].slice(0, SHOWN_SKILLS);
}

export const EmptyState = forwardRef<ComposerHandle, Props>(function EmptyState(
  { draft, onDraftChange, onSubmit, skills, initialSkillId, canManageSkills, allowFiles, footnote, setup, agentName, member, greeter, onSetup, onSkipSetup, onTalk, talking, talkNotice, onSayHello, voice, call },
  composerRef,
) {
  const composer = composerRef && typeof composerRef === "object" ? composerRef : null;
  const companion = useCompanion();
  // Until setup is done, the agent greets them and offers to guide them through it.
  const greeting = Boolean(setup && onSetup);

  function attach(skill: WorkspaceSkill) {
    composer?.current?.attachSkill({ id: skill.id, name: skill.name });
  }

  // Opened from "Use" on the skills page: attach it, and drop the query so a reload doesn't.
  useEffect(() => {
    const skill = skills.find((s) => s.id === initialSkillId);
    if (!skill) return;
    composer?.current?.attachSkill({ id: skill.id, name: skill.name });
    window.history.replaceState(null, "", window.location.pathname);
  }, []); // Once, on mount.

  function pick(s: Suggestion) {
    if (s.prompt) onSubmit(s.prompt);
    else if (s.prefill && composerRef && typeof composerRef === "object") composerRef.current?.setValue(s.prefill);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 md:justify-center md:px-8 md:pb-[12vh]">
      <div className="flex flex-1 flex-col items-center justify-center gap-4 md:flex-none">
        {companion ? (
          <span title={companionHint(companion.stage, companion.name)} className="animate-fade-up">
            <Companion stage={companion.stage} look={companion.look} size={48} seenKey={companion.workspaceId} present />
          </span>
        ) : null}
        <h1 className="animate-fade-up text-center font-display text-[30px] leading-tight tracking-[-0.015em] text-fg md:text-[36px]">
          {greeting ? `Hey${member ? ` ${member}` : ""}!` : "What should we work on?"}
        </h1>
      </div>

      <div className="mx-auto w-full max-w-[44rem] pb-[max(12px,env(safe-area-inset-bottom))] md:mt-8 md:pb-0">
        {onSayHello && companion ? <Hello workspaceId={companion.workspaceId} onSayHello={onSayHello} /> : null}
        {setup && onSetup ? (
          <SetupGreeting setup={setup} agentName={agentName} greeter={greeter} onSetup={onSetup} onSkip={onSkipSetup} onTalk={onTalk} talking={talking} notice={talkNotice} />
        ) : null}
        <div className="animate-fade-up [animation-delay:60ms]">
          <Composer
            ref={composerRef}
            variant="hero"
            initialValue={draft}
            onDraftChange={onDraftChange}
            onSubmit={onSubmit}
            onStop={() => {}}
            running={false}
            placeholder={skills.length > 0 ? "Ask anything, or type / for a skill" : "Ask anything, or describe a task"}
            skills={skills}
            autoFocus
            allowFiles={allowFiles}
            voice={voice}
            call={call}
          />
          {/* Why a call from the message box couldn't start (the setup's own call says so above). */}
          {talkNotice && !(setup && onSetup) ? (
            <p role="status" className="mt-2 px-1 text-center text-[12.5px] text-danger">
              {talkNotice}
            </p>
          ) : null}
        </div>
        <ul className="mt-4 flex flex-wrap justify-center gap-1.5 animate-fade-up [animation-delay:120ms]" aria-label="Suggestions">
          {skills.length > 0
            ? chipSkills(skills).map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => attach(s)} className={chip} title={s.description || undefined}>
                    <Sparkles size={14} strokeWidth={1.75} className="text-fg-3" />
                    {s.name}
                  </button>
                </li>
              ))
            : SUGGESTIONS.map((s) => (
                <li key={s.label}>
                  <button type="button" onClick={() => pick(s)} className={chip}>
                    <s.icon size={14} strokeWidth={1.75} className="text-fg-3" />
                    {s.label}
                  </button>
                </li>
              ))}
          <li>
            <a href="/skills" className={chip}>
              <LibraryBig size={14} strokeWidth={1.75} className="text-fg-3" />
              {skills.length > SHOWN_SKILLS ? "All skills" : canManageSkills ? "Add skills" : "Skills"}
            </a>
          </li>
        </ul>
        <div className="mt-6 text-center md:mt-8">{footnote}</div>
      </div>
    </div>
  );
});

/**
 * The agent's greeting until its setup is done: what it would like to do with them (or where they
 * left off), and one clear way in. With calls, talking it through comes first; typing is the
 * other way, with equal footing; "Not now" sets it aside.
 */
function SetupGreeting({
  setup,
  agentName,
  greeter,
  onSetup,
  onSkip,
  onTalk,
  talking,
  notice,
}: {
  setup: SetupSummary;
  agentName?: string;
  greeter?: string | null;
  onSetup: () => void;
  onSkip?: () => void;
  onTalk?: () => void;
  talking?: boolean;
  notice?: string | null;
}) {
  const started = setup.status === "in_progress";
  const at = setup.plan.findIndex((s) => s.status === "doing" || s.status === "needs_you");
  const index = at >= 0 ? at : setup.plan.findIndex((s) => s.status !== "done");
  const current = index >= 0 ? setup.plan[index] : null;
  const who = greeter ? `It's ${greeter}.` : `Let's set up ${agentName?.trim() || "your agent"}.`;
  const title = started ? "Welcome back. Let's pick up where we left off." : `${who} Before I get to work, let's make sure I work the way you need.`;
  const detail = started
    ? current
      ? `Step ${index + 1}: ${stepName(current.text)}.`
      : "Almost there."
    : "A few minutes on what you're after. I'll guide you through it, one step at a time.";
  const primary = "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-inverse px-3.5 text-[13.5px] font-medium text-on-inverse transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.97] disabled:opacity-60";
  const secondary = "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-line-strong px-3.5 text-[13.5px] font-medium text-fg transition-[background-color,transform] duration-150 hover:bg-hover active:scale-[0.97]";
  return (
    <section aria-label="Set up this agent" className="mb-3 rounded-xl border border-line bg-surface px-4 py-3.5 animate-fade-up">
      <div className="flex items-start gap-3">
        <Sparkles size={17} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] font-medium leading-[1.45] text-fg">{title}</p>
          {started && setup.plan.length > 0 ? (
            <div className="mt-2 flex items-center gap-2.5">
              <JourneyBar steps={setup.plan} className="max-w-48 flex-1" />
              <span className="min-w-0 truncate text-[12.5px] text-fg-3">{detail}</span>
            </div>
          ) : (
            <p className="mt-0.5 text-[13px] leading-[1.45] text-fg-3">{detail}</p>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {onSkip ? (
          <button
            type="button"
            onClick={onSkip}
            className="mr-auto inline-flex h-9 shrink-0 items-center rounded-lg px-2 text-[13px] font-medium text-fg-3 transition-colors hover:bg-hover hover:text-fg"
          >
            Not now
          </button>
        ) : null}
        {onTalk ? (
          <>
            <button type="button" onClick={onSetup} className={secondary}>
              {started ? "Continue typing" : "Type instead"}
            </button>
            <button type="button" onClick={onTalk} disabled={talking} className={primary}>
              {talking ? <span className="spinner size-3.5" aria-hidden="true" /> : <AudioLines size={15} />}
              Talk it through
            </button>
          </>
        ) : (
          <button type="button" onClick={onSetup} className={primary}>
            {started ? "Continue" : "Let's start"}
            <ArrowRight size={14} />
          </button>
        )}
      </div>
      {notice ? (
        <p role="status" className="mt-2 text-[12.5px] text-danger">
          {notice}
        </p>
      ) : null}
    </section>
  );
}

// "Later" hides the offer until tomorrow; after a few, it's only offered on the agent's page.
const LATER_KEY = "lj.hello-later:";
const LATER_LIMIT = 3;

function laterState(workspaceId: string): { count: number; until: number } {
  try {
    const raw = JSON.parse(window.localStorage.getItem(LATER_KEY + workspaceId) ?? "null") as { count?: number; until?: number } | null;
    return { count: raw?.count ?? 0, until: raw?.until ?? 0 };
  } catch {
    return { count: 0, until: 0 };
  }
}

/** The agent, once it knows the member, offering to introduce itself. Never inside a chat. */
function Hello({ workspaceId, onSayHello }: { workspaceId: string; onSayHello: () => void }) {
  // Decided after hydration, since it depends on this device's storage.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const later = laterState(workspaceId);
    setShown(later.count < LATER_LIMIT && Date.now() >= later.until);
  }, [workspaceId]);

  function later() {
    const { count } = laterState(workspaceId);
    const tomorrow = new Date();
    tomorrow.setHours(24, 0, 0, 0);
    try {
      window.localStorage.setItem(LATER_KEY + workspaceId, JSON.stringify({ count: count + 1, until: tomorrow.getTime() }));
    } catch {
      // Without storage it just comes back next visit.
    }
    setShown(false);
  }

  if (!shown) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-center animate-fade-up">
      <p className="text-[14.5px] text-fg-2">I think I know you well enough to introduce myself.</p>
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={later} className="h-8 rounded-lg px-3 text-[13px] font-medium text-fg-3 transition-colors hover:bg-hover hover:text-fg">
          Later
        </button>
        <button
          type="button"
          onClick={onSayHello}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-inverse px-3.5 text-[13px] font-medium text-on-inverse transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.97]"
        >
          Say hello
        </button>
      </div>
    </div>
  );
}

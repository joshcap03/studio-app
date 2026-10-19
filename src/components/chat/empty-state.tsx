"use client";

import { ArrowRight, AudioLines, CalendarDays, Inbox, LibraryBig, Search, Sheet, Sparkles, type LucideIcon } from "lucide-react";
import { forwardRef, useEffect } from "react";
import { JourneyBar } from "@/components/ui/journey";
import type { SetupSummary, WorkspaceSkill } from "@/lib/types";
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
  onSetup?: () => void;
  onSkipSetup?: () => void;
  /** Present when the member can do the setup on a call ("Talk it through"). */
  onTalk?: () => void;
  /** A call is being started. */
  talking?: boolean;
  /** Why a call couldn't start. */
  talkNotice?: string | null;
}

const chip =
  "inline-flex h-8 items-center gap-2 rounded-full border border-line px-3 text-[13px] text-fg-2 transition-colors hover:border-line-strong hover:bg-surface hover:text-fg";
const SHOWN_SKILLS = 5;

export const EmptyState = forwardRef<ComposerHandle, Props>(function EmptyState(
  { draft, onDraftChange, onSubmit, skills, initialSkillId, canManageSkills, allowFiles, footnote, setup, agentName, onSetup, onSkipSetup, onTalk, talking, talkNotice },
  composerRef,
) {
  const composer = composerRef && typeof composerRef === "object" ? composerRef : null;

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
      <div className="flex flex-1 items-center justify-center md:flex-none">
        <h1 className="animate-fade-up text-center font-display text-[30px] leading-tight tracking-[-0.015em] text-fg md:text-[36px]">
          What should we work on?
        </h1>
      </div>

      <div className="mx-auto w-full max-w-[44rem] pb-[max(12px,env(safe-area-inset-bottom))] md:mt-8 md:pb-0">
        {setup && onSetup ? (
          <SetupBanner setup={setup} agentName={agentName} onSetup={onSetup} onSkip={onSkipSetup} onTalk={onTalk} talking={talking} notice={talkNotice} />
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
          />
        </div>
        <ul className="mt-4 flex flex-wrap justify-center gap-1.5 animate-fade-up [animation-delay:120ms]" aria-label="Suggestions">
          {skills.length > 0
            ? skills.slice(0, SHOWN_SKILLS).map((s) => (
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
 * Offers the agent's setup interview until it's done: start it (typing, or talking it through on a
 * call, with equal weight), pick it up again, or not now.
 */
function SetupBanner({
  setup,
  agentName,
  onSetup,
  onSkip,
  onTalk,
  talking,
  notice,
}: {
  setup: SetupSummary;
  agentName?: string;
  onSetup: () => void;
  onSkip?: () => void;
  onTalk?: () => void;
  talking?: boolean;
  notice?: string | null;
}) {
  const started = setup.status === "in_progress";
  const name = agentName?.trim() || "this agent";
  return (
    <section aria-label="Set up this agent" className="mb-3 rounded-xl border border-line bg-surface px-3.5 py-3 animate-fade-up">
      <div className="flex flex-wrap items-center gap-3">
        <Sparkles size={17} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium text-fg">{started ? `Finish setting up ${name}` : `Set up ${name}`}</p>
          {started && setup.total > 0 ? (
            <div className="mt-1.5 flex items-center gap-2.5">
              <JourneyBar steps={setup.plan} className="max-w-48 flex-1" />
              <span className="shrink-0 text-[12px] text-fg-3">
                {setup.done} {setup.done === 1 ? "step" : "steps"} done
              </span>
            </div>
          ) : (
            <p className="text-[12.5px] leading-[1.45] text-fg-3">
              A short conversation about what you need, so it works the way you need.
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 max-sm:w-full max-sm:justify-end">
          {onSkip ? (
            <button
              type="button"
              onClick={onSkip}
              className="inline-flex h-8 shrink-0 items-center rounded-lg px-2.5 text-[13px] font-medium text-fg-3 transition-colors hover:bg-hover hover:text-fg"
            >
              Not now
            </button>
          ) : null}
          {onTalk ? (
            <button
              type="button"
              onClick={onTalk}
              disabled={talking}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-[13px] font-medium text-fg transition-colors hover:bg-hover disabled:opacity-60"
            >
              {talking ? <span className="spinner size-3.5" aria-hidden="true" /> : <AudioLines size={14} />}
              Talk it through
            </button>
          ) : null}
          <button
            type="button"
            onClick={onSetup}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-inverse px-3 text-[13px] font-medium text-on-inverse transition-opacity hover:opacity-90"
          >
            {started ? "Continue" : "Start"}
            <ArrowRight size={14} />
          </button>
        </div>
      </div>
      {notice ? (
        <p role="status" className="mt-2 text-[12.5px] text-danger">
          {notice}
        </p>
      ) : null}
    </section>
  );
}

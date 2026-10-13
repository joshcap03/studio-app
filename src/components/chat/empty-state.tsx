"use client";

import { Boxes, Briefcase, LibraryBig, Search, Sheet, Sparkles, type LucideIcon } from "lucide-react";
import { forwardRef, useEffect } from "react";
import type { MessageSkill, WorkspaceSkill } from "@/lib/types";
import { Composer, type ComposerHandle } from "./composer";

interface Suggestion {
  icon: LucideIcon;
  label: string;
  /** Sent immediately. */
  prompt?: string;
  /** Placed in the composer for the user to finish. */
  prefill?: string;
}

const SUGGESTIONS: Suggestion[] = [
  { icon: Boxes, label: "Analyze my inventory", prompt: "Analyze my inventory and flag anything that needs attention." },
  { icon: Sheet, label: "Create a spreadsheet", prefill: "Create a spreadsheet of " },
  { icon: Search, label: "Research a competitor", prefill: "Research this competitor and summarize their pricing and positioning: " },
  { icon: Briefcase, label: "Help with operations", prompt: "Help me with business operations. What can you take off my plate?" },
];

interface Props {
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: (text: string, skill: MessageSkill | null) => void;
  /** The workspace's skills; when there are any, they replace the generic suggestions. */
  skills: WorkspaceSkill[];
  /** A skill to attach on load (from "Use" on the skills page). */
  initialSkillId: string | null;
  canManageSkills: boolean;
  footnote: React.ReactNode;
}

const chip =
  "inline-flex h-8 items-center gap-2 rounded-full border border-line px-3 text-[13px] text-fg-2 transition-colors hover:border-line-strong hover:bg-surface hover:text-fg";
const SHOWN_SKILLS = 5;

export const EmptyState = forwardRef<ComposerHandle, Props>(function EmptyState(
  { draft, onDraftChange, onSubmit, skills, initialSkillId, canManageSkills, footnote },
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
    if (s.prompt) onSubmit(s.prompt, null);
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

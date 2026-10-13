"use client";

import { ArrowUp, Sparkles, X } from "lucide-react";
import { forwardRef, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Tooltip } from "radix-ui";
import { TooltipContent } from "@/components/ui/icon-button";
import { useMedia } from "@/components/ui/use-media";
import { MAX_MESSAGE_LENGTH, type MessageSkill, type WorkspaceSkill } from "@/lib/types";

export interface ComposerHandle {
  focus(): void;
  /** Replace the draft and place the caret at the end. */
  setValue(value: string): void;
  /** Attach a skill to the next message. */
  attachSkill(skill: MessageSkill): void;
}

interface Props {
  initialValue?: string;
  onDraftChange?: (value: string) => void;
  onSubmit: (text: string, skill: MessageSkill | null) => void;
  onStop: () => void;
  running: boolean;
  placeholder: string;
  autoFocus?: boolean;
  variant?: "hero" | "default";
  /** The workspace's skills, offered when the message starts with "/". */
  skills?: WorkspaceSkill[];
}

const MAX_HEIGHT = 240;

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { initialValue = "", onDraftChange, onSubmit, onStop, running, placeholder, autoFocus, variant = "default", skills = [] },
  ref,
) {
  const [value, setValue] = useState(initialValue);
  const [skill, setSkill] = useState<MessageSkill | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // On touch devices Return inserts a newline; sending is done with the button.
  const coarse = useMedia("(pointer: coarse)");
  const canSend = (value.trim().length > 0 || skill !== null) && !running;

  // "/" at the start of an empty-ish message opens the skill menu, filtered by what follows.
  const matches = useMemo(() => {
    const slash = /^\/(\S*)$/.exec(value);
    if (!slash || skills.length === 0) return [];
    const q = slash[1].toLowerCase();
    return skills.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 8);
  }, [value, skills]);
  const menuOpen = matches.length > 0 && !menuDismissed;

  function focusEnd(next: string) {
    requestAnimationFrame(() => {
      const el = textarea.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
    });
  }

  useImperativeHandle(ref, () => ({
    focus: () => textarea.current?.focus(),
    setValue: (next) => {
      update(next);
      focusEnd(next);
    },
    attachSkill: (next) => {
      setSkill(next);
      focusEnd(value);
    },
  }));

  // Grow with content up to MAX_HEIGHT, then scroll inside.
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [value]);

  function update(next: string) {
    setValue(next);
    setHighlight(0);
    setMenuDismissed(false);
    onDraftChange?.(next);
  }

  function pick(s: WorkspaceSkill) {
    setSkill({ id: s.id, name: s.name });
    update("");
    focusEnd("");
  }

  function submit() {
    if (!canSend) return;
    onSubmit(value.trim(), skill);
    update("");
    setSkill(null);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((h) => (h + step + matches.length) % matches.length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        event.preventDefault();
        pick(matches[Math.min(highlight, matches.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (event.key === "Backspace" && skill && value === "") {
      setSkill(null);
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !coarse) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape" && running) {
      event.preventDefault();
      onStop();
    }
  }

  const hero = variant === "hero";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={`group/composer relative flex cursor-text flex-wrap items-end gap-2 border border-line bg-surface shadow-composer transition-[border-color,box-shadow] duration-200 focus-within:border-line-strong ${
        hero ? "rounded-[20px] p-2.5 pl-[18px]" : "rounded-[18px] p-2 pl-4"
      }`}
      onMouseDown={(e) => {
        // Clicking the padding focuses the field, like a native input.
        if (e.target === e.currentTarget) {
          e.preventDefault();
          textarea.current?.focus();
        }
      }}
    >
      {menuOpen ? (
        <ul
          id="composer-skills"
          role="listbox"
          aria-label="Skills"
          className="absolute right-0 bottom-full left-0 z-30 mb-2 max-h-72 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-pop animate-fade-in"
        >
          {matches.map((s, i) => (
            <li
              key={s.id}
              id={`composer-skill-${s.id}`}
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={`flex cursor-default items-start gap-2.5 rounded-lg px-2.5 py-2 ${i === highlight ? "bg-hover" : ""}`}
            >
              <Sparkles size={14} className="mt-0.5 shrink-0 text-fg-3" />
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] text-fg">{s.name}</span>
                {s.description ? <span className="block truncate text-[12px] text-fg-3">{s.description}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {skill ? (
        <span className="mt-0.5 inline-flex h-7 max-w-full basis-full items-center">
          <span className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-accent-soft pr-1 pl-2.5 text-[13px] font-medium text-accent">
            <Sparkles size={13} className="shrink-0" />
            <span className="truncate">{skill.name}</span>
            <button
              type="button"
              aria-label={`Remove ${skill.name}`}
              onClick={() => {
                setSkill(null);
                textarea.current?.focus();
              }}
              className="flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-accent-soft"
            >
              <X size={12} />
            </button>
          </span>
        </span>
      ) : null}
      <label htmlFor="composer-input" className="sr-only">
        Message
      </label>
      <textarea
        id="composer-input"
        ref={textarea}
        rows={1}
        value={value}
        maxLength={MAX_MESSAGE_LENGTH}
        autoFocus={autoFocus}
        placeholder={skill ? "Add details (optional)" : placeholder}
        onChange={(e) => update(e.target.value)}
        onKeyDown={onKeyDown}
        enterKeyHint={coarse ? "enter" : "send"}
        role={skills.length > 0 ? "combobox" : undefined}
        aria-expanded={skills.length > 0 ? menuOpen : undefined}
        aria-controls={menuOpen ? "composer-skills" : undefined}
        aria-activedescendant={menuOpen ? `composer-skill-${matches[highlight]?.id}` : undefined}
        aria-autocomplete={skills.length > 0 ? "list" : undefined}
        className={`scroll-quiet block w-full min-w-0 flex-1 resize-none bg-transparent leading-6 text-fg outline-none focus-visible:outline-none placeholder:text-fg-4 max-md:text-[16px] ${
          hero ? "min-h-[56px] py-1.5 text-[16px]" : "min-h-8 py-1 text-[15px]"
        }`}
      />
      {running ? (
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generating"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-inverse text-on-inverse transition-transform active:scale-90"
            >
              <span className="size-2.5 rounded-[2px] bg-current" />
            </button>
          </Tooltip.Trigger>
          <TooltipContent label="Stop" shortcut="Esc" side="top" />
        </Tooltip.Root>
      ) : (
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send message"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-inverse text-on-inverse transition-[background-color,color,transform] duration-150 active:scale-90 disabled:bg-press disabled:text-fg-4"
        >
          <ArrowUp size={17} strokeWidth={2.25} />
        </button>
      )}
    </form>
  );
});

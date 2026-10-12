"use client";

import { ArrowUp } from "lucide-react";
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Tooltip } from "radix-ui";
import { TooltipContent } from "@/components/ui/icon-button";
import { useMedia } from "@/components/ui/use-media";
import { MAX_MESSAGE_LENGTH } from "@/lib/types";

export interface ComposerHandle {
  focus(): void;
  /** Replace the draft and place the caret at the end. */
  setValue(value: string): void;
}

interface Props {
  initialValue?: string;
  onDraftChange?: (value: string) => void;
  onSubmit: (text: string) => void;
  onStop: () => void;
  running: boolean;
  placeholder: string;
  autoFocus?: boolean;
  variant?: "hero" | "default";
}

const MAX_HEIGHT = 240;

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { initialValue = "", onDraftChange, onSubmit, onStop, running, placeholder, autoFocus, variant = "default" },
  ref,
) {
  const [value, setValue] = useState(initialValue);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // On touch devices Return inserts a newline; sending is done with the button.
  const coarse = useMedia("(pointer: coarse)");
  const canSend = value.trim().length > 0 && !running;

  useImperativeHandle(ref, () => ({
    focus: () => textarea.current?.focus(),
    setValue: (next) => {
      update(next);
      requestAnimationFrame(() => {
        const el = textarea.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(next.length, next.length);
      });
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
    onDraftChange?.(next);
  }

  function submit() {
    if (!canSend) return;
    onSubmit(value.trim());
    update("");
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !coarse) {
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
      className={`group/composer relative flex cursor-text items-end gap-2 border border-line bg-surface shadow-composer transition-[border-color,box-shadow] duration-200 focus-within:border-line-strong ${
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
        placeholder={placeholder}
        onChange={(e) => update(e.target.value)}
        onKeyDown={onKeyDown}
        enterKeyHint={coarse ? "enter" : "send"}
        className={`scroll-quiet block w-full flex-1 resize-none bg-transparent leading-6 text-fg outline-none focus-visible:outline-none placeholder:text-fg-4 max-md:text-[16px] ${
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

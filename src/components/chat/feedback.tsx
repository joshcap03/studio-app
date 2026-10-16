"use client";

import { ThumbsDown, ThumbsUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { FEEDBACK_REASONS, MAX_FEEDBACK_NOTE_LENGTH, type MessageFeedback } from "@/lib/types";

type Rating = MessageFeedback["rating"];

/** The thumbs in a reply's action bar. A click rates the reply at once, then asks why. */
export function FeedbackButtons({
  feedback,
  asking,
  onRate,
}: {
  feedback: MessageFeedback | null;
  /** The rating whose "why?" panel is open, if any. */
  asking: Rating | null;
  onRate: (rating: Rating) => void;
}) {
  return (
    <>
      {(["up", "down"] as const).map((rating) => {
        const chosen = feedback?.rating === rating;
        const Icon = rating === "up" ? ThumbsUp : ThumbsDown;
        return (
          <IconButton
            key={rating}
            label={chosen ? "Remove rating" : rating === "up" ? "Good response" : "Bad response"}
            side="bottom"
            aria-pressed={chosen}
            aria-expanded={asking === rating || undefined}
            onClick={() => onRate(rating)}
            className={`size-7 ${chosen ? "text-fg" : ""}`}
          >
            <Icon size={14} fill={chosen ? "currentColor" : "none"} strokeWidth={chosen ? 1.5 : 2} />
          </IconButton>
        );
      })}
    </>
  );
}

/** Asks why the member rated a reply the way they did: quick reasons and an optional note. */
export function FeedbackReasons({
  feedback,
  onSave,
  onClose,
}: {
  feedback: MessageFeedback;
  onSave: (feedback: MessageFeedback) => void;
  onClose: () => void;
}) {
  const [reasons, setReasons] = useState<string[]>(feedback.reasons);
  const [note, setNote] = useState(feedback.note ?? "");
  const panel = useRef<HTMLFormElement>(null);
  const options: readonly string[] = FEEDBACK_REASONS[feedback.rating];
  const changed = reasons.length > 0 || note.trim().length > 0;

  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>("button[aria-pressed]")?.focus({ preventScroll: true });
  }, []);

  const toggle = (reason: string) => setReasons((current) => (current.includes(reason) ? current.filter((r) => r !== reason) : [...current, reason]));

  return (
    <form
      ref={panel}
      aria-label="Feedback on this response"
      className="mt-2 rounded-xl border border-line-strong bg-surface p-3 animate-fade-up"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!changed) return;
        const trimmed = note.trim();
        onSave({ rating: feedback.rating, reasons, ...(trimmed ? { note: trimmed } : {}) });
      }}
    >
      <div className="flex items-center justify-between gap-2 pl-1">
        <p className="text-[13px] font-medium text-fg-2">{feedback.rating === "up" ? "What was good about it?" : "What went wrong?"}</p>
        <IconButton label="Close" side="bottom" onClick={onClose} className="size-7">
          <X size={14} />
        </IconButton>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {options.map((reason) => {
          const on = reasons.includes(reason);
          return (
            <button
              key={reason}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(reason)}
              className={`inline-flex h-7 items-center rounded-full border px-3 text-[13px] transition-colors ${
                on ? "border-accent bg-accent-soft text-fg" : "border-line-strong text-fg-2 hover:bg-hover hover:text-fg"
              }`}
            >
              {reason}
            </button>
          );
        })}
      </div>
      <label htmlFor="feedback-note" className="sr-only">
        Anything else?
      </label>
      <textarea
        id="feedback-note"
        rows={2}
        value={note}
        maxLength={MAX_FEEDBACK_NOTE_LENGTH}
        placeholder="Anything else? (optional)"
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
        className="scroll-quiet mt-2.5 block w-full resize-none rounded-lg border border-line bg-transparent px-2.5 py-2 text-[14px] leading-[1.5] text-fg outline-none placeholder:text-fg-4 focus:border-line-strong"
      />
      <div className="mt-2 flex justify-end">
        <button
          type="submit"
          disabled={!changed}
          className="inline-flex h-8 items-center rounded-lg bg-inverse px-3.5 text-[13px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:bg-press disabled:text-fg-4"
        >
          Send feedback
        </button>
      </div>
    </form>
  );
}

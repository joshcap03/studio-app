"use client";

import { useState } from "react";

// Beside each part's editor: describe a change in words instead. They go into the Try pane's message
// box, not sent, so the member reads them, adds a word, and presses send; the agent answers with what
// it already has (a proposal card). Studio never sends on the member's behalf.

export const primaryAsk =
  "inline-flex h-8 items-center gap-1.5 rounded-lg bg-inverse px-3 text-[13px] font-medium text-on-inverse transition-opacity hover:opacity-90";
export const secondaryAsk =
  "inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] font-medium text-fg-2 transition-colors hover:border-line-strong hover:bg-hover hover:text-fg disabled:opacity-40";
export const quietLink = "text-[13px] font-medium text-fg-3 transition-colors hover:text-fg";

export function DescribeBar({ lead, placeholder, onDescribe }: { /** The sentence the member's words finish. */ lead: string; placeholder: string; onDescribe: (text: string) => void }) {
  const [words, setWords] = useState("");
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onDescribe(`${lead}${words.trim()}`);
        setWords("");
      }}
    >
      <input
        aria-label="Describe the change"
        value={words}
        onChange={(e) => setWords(e.target.value)}
        placeholder={placeholder}
        className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-fg outline-none transition-colors placeholder:text-fg-4 focus:border-line-strong focus-visible:outline-none"
      />
      <button type="submit" className={secondaryAsk}>
        Draft it
      </button>
    </form>
  );
}

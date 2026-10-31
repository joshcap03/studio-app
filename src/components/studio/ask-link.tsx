"use client";

import type { ReactNode } from "react";

// Every primary action on the agent's page is a sentence the member would say to it. It opens the
// agent's new-chat screen with those words in the message box, not sent, so they read it, add a
// word, and press send themselves; the agent answers with what it already has (a proposal card).
// Studio never sends on the member's behalf.

export const primaryAsk =
  "inline-flex h-8 items-center gap-1.5 rounded-lg bg-inverse px-3 text-[13px] font-medium text-on-inverse transition-opacity hover:opacity-90";
export const quietLink = "text-[13px] font-medium text-fg-3 transition-colors hover:text-fg";

/** The address of the new-chat screen with `text` waiting in the box (and a skill attached, if given). */
export function askPath(text: string, skillId?: string | null): string {
  return `/new?ask=${encodeURIComponent(text)}${skillId ? `&skill=${encodeURIComponent(skillId)}` : ""}`;
}

export function Ask({
  text,
  skillId,
  onGo,
  tone = "primary",
  children,
}: {
  text: string;
  skillId?: string | null;
  /** Goes there in place (the shell's own navigation); a modifier click opens a tab as usual. */
  onGo: (path: string) => void;
  tone?: "primary" | "quiet";
  children: ReactNode;
}) {
  const path = askPath(text, skillId);
  return (
    <a
      href={path}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onGo(path);
      }}
      className={tone === "primary" ? primaryAsk : quietLink}
    >
      {children}
    </a>
  );
}

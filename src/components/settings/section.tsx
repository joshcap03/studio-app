"use client";

import { useEffect, useState } from "react";
import { isMac } from "@/components/ui/use-media";

export const input =
  "w-full rounded-xl border border-line bg-surface px-3.5 text-[14.5px] text-fg outline-none transition-[border-color,box-shadow] placeholder:text-fg-4 focus:border-line-strong focus:shadow-composer focus-visible:outline-none disabled:bg-subtle/50 disabled:text-fg-2";

export function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
      {description ? <p className="mt-1 text-[13.5px] text-fg-3">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** ⌘/Ctrl+Enter anywhere in a form submits it, like the chat composer. */
export function submitOnModEnter(event: React.KeyboardEvent<HTMLFormElement>) {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    event.currentTarget.requestSubmit();
  }
}

/** Ask before leaving the page while a form has unsaved edits. */
export function useWarnUnsaved(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}

/** The submit button and its status; while there are edits it hints at the shortcut. */
export function SaveRow({ dirty, status, error, label, disabled }: { dirty: boolean; status: "idle" | "saving" | "saved" | "error"; error: string | null; label: string; disabled?: boolean }) {
  const [mod, setMod] = useState("Ctrl+");
  useEffect(() => setMod(isMac() ? "⌘" : "Ctrl+"), []);
  return (
    <div className="flex items-center gap-3">
      <button
        type="submit"
        disabled={!dirty || status === "saving" || disabled}
        className="h-9 rounded-lg bg-inverse px-3.5 text-[13.5px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:opacity-30"
      >
        {status === "saving" ? "Saving…" : label}
      </button>
      <span role="status" className={`text-[13px] ${status === "error" ? "text-danger" : "text-fg-3"}`}>
        {status === "error" ? error : dirty ? <span className="text-fg-4 max-md:hidden">{mod}Enter to save</span> : status === "saved" ? "Saved" : ""}
      </span>
    </div>
  );
}

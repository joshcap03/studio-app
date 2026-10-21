"use client";

import { Check, Globe, MousePointerClick, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import type { Attachment, UiHandoff, UiResponse } from "@/lib/types";

// The agent's browser, handed to the member (its hand_browser tool) for a step only they can do:
// signing in, a code sent to them. Nothing happens until they tap Take over, which asks the server
// for a live view of the page the agent is on (src/lib/browser-view.ts) and opens it here for them
// to click and type in. Done hands it back: the card is marked and their "done" goes out as their
// next message, so the agent picks up from the page as they left it. The link is held only while
// the panel is open, never stored.

/** What the member says when they hand the browser back, as their next message. */
export function handBackText(handoff: UiHandoff): string {
  return `I'm done in the browser${handoff.site ? ` on ${handoff.site}` : ""}. Carry on from there.`;
}

const card = "mt-4 overflow-hidden rounded-xl border border-line-strong bg-surface shadow-composer animate-fade-up";
const primary =
  "inline-flex h-8 items-center gap-1.5 rounded-lg bg-inverse px-3.5 text-[13px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:bg-press disabled:text-fg-4";

/** Live view messages come only from Browserbase's own pages. */
const fromBrowserbase = (origin: string) => /^https:\/\/(?:[a-z0-9-]+\.)*browserbase\.com$/i.test(origin);

export function HandoffCard({
  handoff,
  response,
  conversationId,
  messageId,
  onAnswer,
  onResponse,
}: {
  handoff: UiHandoff;
  response?: UiResponse;
  conversationId: string;
  messageId: string;
  /** Present while the browser can be taken (the latest reply, agent idle). */
  onAnswer?: (text: string, extras: { attachments: Attachment[] }) => void;
  onResponse?: (messageId: string, blockId: string, response: UiResponse) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<"take" | "done" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [handedBack, setHandedBack] = useState(false);
  const [closed, setClosed] = useState(false);
  const [touch, setTouch] = useState(false);

  useEffect(() => setTouch(window.matchMedia("(pointer: coarse)").matches), []);

  // The live view says when the browser goes away (it timed out, or the agent closed it).
  useEffect(() => {
    if (!url) return;
    const onMessage = (event: MessageEvent) => {
      if (fromBrowserbase(event.origin) && event.data === "browserbase-disconnected") setClosed(true);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [url]);

  const where = handoff.site ? ` on ${handoff.site}` : "";
  if (!onAnswer || handedBack || response) {
    const back = handedBack || response?.status === "handed-back";
    return (
      <section aria-label="Browser handed to you" className="mt-3 flex items-start gap-2 text-[13px] leading-[1.5] text-fg-3 animate-fade-up">
        {back ? <Check size={14} className="settle-check mt-[3px] shrink-0 text-success" /> : <Globe size={14} className="mt-[3px] shrink-0 text-fg-4" />}
        <span className="min-w-0 [overflow-wrap:anywhere]">
          Handed you the browser{where}
          {back ? <span className="text-fg-4"> · You handed it back</span> : null}
        </span>
      </section>
    );
  }
  const answer = onAnswer;

  async function take() {
    setBusy("take");
    setError(null);
    setClosed(false);
    try {
      setUrl((await api.takeBrowser(conversationId)).url);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't reach the browser just now. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function done() {
    setBusy("done");
    setError(null);
    try {
      const { response: saved } = await api.answerUi(conversationId, handoff.id, { action: "handback" });
      onResponse?.(messageId, handoff.id, saved);
    } catch (e) {
      // Already handed back (another tab): still say so, once.
      if (!(e instanceof ApiError && e.status === 409)) {
        setError(e instanceof ApiError ? e.message : "Couldn't hand it back. Try again.");
        setBusy(null);
        return;
      }
    }
    setUrl(null);
    setHandedBack(true);
    setBusy(null);
    answer(handBackText(handoff), { attachments: [] });
  }

  return (
    <section aria-label="Browser handed to you" className={card}>
      <div className="flex items-start gap-3 px-4 pt-3.5 pb-3">
        <MousePointerClick size={17} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] font-medium leading-[1.45] text-fg">Your turn in the browser{where}</p>
          <p className="mt-0.5 text-[13.5px] leading-[1.5] text-fg-2 [overflow-wrap:anywhere]">{handoff.reason}</p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line px-3 py-2.5">
        <span className={`mr-auto min-w-0 pl-1 text-[12px] ${error ? "text-danger" : "text-fg-3"}`}>
          {error ?? "I don't see what you type, and I'll wait until you're done."}
        </span>
        <button type="button" onClick={() => void take()} disabled={busy !== null} className={primary}>
          {busy === "take" ? <span className="spinner size-3.5" aria-hidden="true" /> : <MousePointerClick size={14} />}
          Take over
        </button>
      </div>

      <Dialog.Root open={url !== null} onOpenChange={(open) => (open ? undefined : setUrl(null))}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 animate-fade-in" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-0 z-50 flex flex-col bg-bg sm:inset-6 sm:mx-auto sm:max-w-[1180px] sm:rounded-2xl sm:border sm:border-line sm:shadow-pop sm:overflow-hidden animate-fade-up"
          >
            <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
              <MousePointerClick size={16} className="shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <Dialog.Title className="truncate text-[14px] font-medium text-fg">You have the browser{where}</Dialog.Title>
                <p className={`truncate text-[12.5px] ${error || closed ? "text-danger" : "text-fg-3"}`}>
                  {error ?? (closed ? "The browser closed. Close this and ask me to open the page again." : touch ? "Typing here works best on a computer." : handoff.reason)}
                </p>
              </div>
              <button type="button" onClick={() => void done()} disabled={busy !== null} className={primary}>
                {busy === "done" ? <span className="spinner size-3.5" aria-hidden="true" /> : <Check size={14} />}
                Done
              </button>
              <Dialog.Close
                aria-label="Close without handing it back"
                className="inline-flex size-8 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-hover hover:text-fg"
              >
                <X size={16} />
              </Dialog.Close>
            </div>
            {url ? (
              <iframe
                src={url}
                title={`The agent's browser${where}`}
                // Browserbase's live view needs its own scripts and origin; nothing else is allowed.
                sandbox="allow-same-origin allow-scripts"
                allow="clipboard-read; clipboard-write"
                referrerPolicy="no-referrer"
                className="min-h-0 w-full flex-1 bg-surface"
              />
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}

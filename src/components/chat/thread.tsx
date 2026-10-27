"use client";

import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Attachment, ChatMessage, MessageFeedback, UiResponse } from "@/lib/types";
import { recapsByMessage, type RecapCall } from "@/lib/voice/recap";
import { CallRecapCard } from "./call-recap";
import { AssistantMessage, UserMessage } from "./message";
import { pointOutNote } from "./voice-note";

const STICK_THRESHOLD = 64;

interface Props {
  messages: ChatMessage[];
  /** Whether the agent is working in this conversation. */
  running: boolean;
  onRetry: (messageId: string) => void;
  onEdit: (messageId: string, text: string) => void;
  /** `always`: approve, and don't ask again on this task for its kind. */
  onDecide: (approvalId: string, decision: "approve" | "reject", always?: boolean) => void;
  onProposal: (messageId: string, proposalId: string, decision: "save" | "dismiss" | "undo") => void;
  /** Sends the member's answer to the agent's questions as their next message. */
  onAnswer: (text: string, extras?: { attachments: Attachment[] }) => void;
  /** Records what the member did with a card under a reply (a form sent, a proposal applied). */
  onUiResponse: (messageId: string, blockId: string, response: UiResponse) => void;
  /** Runs a task now and opens its conversation (a proposal's "Do the first one now"). */
  onRunTask?: (taskId: string) => Promise<void>;
  onFeedback: (messageId: string, feedback: MessageFeedback | null) => void;
  onOpenPanel?: (messageId: string) => void;
  /** Changes whenever the user sends, to pull the view back to the latest message. */
  sendCount: number;
  /** A reply whose voice note a notification opened: brought into view, its play button pointed out. */
  noteFocus?: string | null;
  /** Starts a call here, from the agent's offer under the latest reply (when the member has calls); resolves with its id. */
  onCall?: () => Promise<string>;
  /** The calls messages here were said on (or that followed a run here); each one that's over gets its recap after its last message. */
  calls?: RecapCall[];
  footer: React.ReactNode;
}

/**
 * The scrolling message list. Follows new output while the reader is at the bottom, and
 * leaves the scroll position alone once they scroll up to read earlier messages.
 */
export function Thread({ messages, running, onRetry, onEdit, onDecide, onProposal, onAnswer, onUiResponse, onRunTask, onFeedback, onOpenPanel, sendCount, noteFocus, onCall, calls, footer }: Props) {
  const lastUserId = messages.findLast((m) => m.role === "user")?.id;
  const recaps = useMemo(() => recapsByMessage(messages, calls ?? []), [messages, calls]);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  useLayoutEffect(() => scrollToBottom(), [scrollToBottom]);

  useEffect(() => {
    // Instant on purpose: positions mid-way through a smooth scroll would read as the
    // reader scrolling up and switch off follow mode.
    if (sendCount > 0) scrollToBottom();
  }, [sendCount, scrollToBottom]);

  // Once the reply is on screen, point out its voice note (in view, and focused, so the keyboard
  // and screen readers land on it too) and stop following new output, so the view stays on it.
  const noteShown = Boolean(noteFocus && messages.some((m) => m.id === noteFocus && m.voiceNote));
  useEffect(() => {
    if (!noteFocus || !noteShown || !pointOutNote(noteFocus)) return;
    stick.current = false;
    setAtBottom(false);
  }, [noteFocus, noteShown]);

  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const bottom = distance < STICK_THRESHOLD;
    stick.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} onScroll={onScroll} className="scroll-quiet min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]">
        <div ref={content} className="mx-auto w-full max-w-[46rem] px-5 pt-6 pb-10 md:px-8 md:pt-10">
          {messages.map((message, index) => {
            const previous = messages[index - 1];
            const spacing = index === 0 ? "" : previous?.role === message.role ? "mt-4" : message.role === "user" ? "mt-10" : "mt-6";
            return (
              <div key={message.id} className={spacing}>
                {message.role === "user" ? (
                  <UserMessage message={message} onEdit={!running && message.id === lastUserId && !message.id.startsWith("pending-") ? onEdit : undefined} />
                ) : (
                  <AssistantMessage
                    message={message}
                    isLast={index === messages.length - 1}
                    onRetry={onRetry}
                    onOpenPanel={onOpenPanel}
                    onDecide={!running && index === messages.length - 1 ? onDecide : undefined}
                    onProposal={onProposal}
                    onAnswer={!running && index === messages.length - 1 ? onAnswer : undefined}
                    onUiResponse={onUiResponse}
                    onRunTask={onRunTask}
                    onCall={!running && index === messages.length - 1 ? onCall : undefined}
                    onFeedback={message.id.startsWith("pending-") ? undefined : onFeedback}
                    noteFocus={message.id === noteFocus}
                  />
                )}
                {recaps.get(message.id)?.map((recap) => <CallRecapCard key={recap.callId} recap={recap} />)}
              </div>
            );
          })}
        </div>
      </div>

      <div className="relative shrink-0">
        <div className="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-gradient-to-b from-transparent to-bg" />
        <button
          type="button"
          onClick={() => scrollToBottom("smooth")}
          aria-label="Jump to latest"
          tabIndex={atBottom ? -1 : 0}
          className={`absolute -top-12 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-surface text-fg-2 shadow-pop transition-[opacity,transform] duration-200 hover:text-fg ${
            atBottom ? "pointer-events-none translate-y-1 opacity-0" : "opacity-100"
          }`}
        >
          <ArrowDown size={15} />
        </button>
        {footer}
      </div>
    </div>
  );
}

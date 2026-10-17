"use client";

import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Attachment, ChatMessage, MessageFeedback, UiResponse } from "@/lib/types";
import { AssistantMessage, UserMessage } from "./message";

const STICK_THRESHOLD = 64;

interface Props {
  messages: ChatMessage[];
  /** Whether the agent is working in this conversation. */
  running: boolean;
  onRetry: (messageId: string) => void;
  onEdit: (messageId: string, text: string) => void;
  onDecide: (approvalId: string, decision: "approve" | "reject") => void;
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
  footer: React.ReactNode;
}

/**
 * The scrolling message list. Follows new output while the reader is at the bottom, and
 * leaves the scroll position alone once they scroll up to read earlier messages.
 */
export function Thread({ messages, running, onRetry, onEdit, onDecide, onProposal, onAnswer, onUiResponse, onRunTask, onFeedback, onOpenPanel, sendCount, footer }: Props) {
  const lastUserId = messages.findLast((m) => m.role === "user")?.id;
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
                    onFeedback={message.id.startsWith("pending-") ? undefined : onFeedback}
                  />
                )}
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

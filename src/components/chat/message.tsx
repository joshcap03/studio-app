"use client";

import { AlertCircle, AudioLines, CalendarClock, Check, Copy, Eye, Mic, Pencil, RotateCcw, Sparkles } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Companion, companionHint, useCompanion, type CompanionMood } from "@/components/ui/companion";
import { IconButton } from "@/components/ui/icon-button";
import { useCallApproval } from "@/components/voice/call-approvals";
import { useCopy } from "@/components/ui/use-copy";
import { moveOf } from "@/lib/chat/move";
import { MAX_MESSAGE_LENGTH, type Approval, type Attachment, type ChatMessage, type MessageFeedback, type UiResponse } from "@/lib/types";
import { ActivityLog } from "./activity";
import { ArtifactCard } from "./artifact-card";
import { AttachmentList } from "./attachments";
import { FeedbackButtons, FeedbackReasons } from "./feedback";
import { SourceList } from "./citation";
import { Markdown } from "./markdown";
import { ApprovalCard, MemoryProposalCard, QuestionCard } from "./requests";
import { UiCards } from "./ui-cards";
import { VisualView } from "./visuals";
import { VoiceNote } from "./voice-note";

interface UserProps {
  message: ChatMessage;
  /** Present when this message can be edited and sent again (the latest one, when idle). */
  onEdit?: (messageId: string, text: string) => void;
}

export const UserMessage = memo(function UserMessage({ message, onEdit }: UserProps) {
  const [editing, setEditing] = useState(false);
  const attachments = message.attachments ?? [];

  if (editing && onEdit) {
    return <EditBox initial={message.content} onCancel={() => setEditing(false)} onSave={(text) => (setEditing(false), onEdit(message.id, text))} />;
  }

  return (
    <div className="group/user flex flex-col items-end gap-1.5 animate-fade-up">
      {attachments.length > 0 ? <AttachmentList attachments={attachments} /> : null}
      {message.origin?.kind === "task" ? (
        <span className="inline-flex h-7 max-w-[min(85%,36rem)] items-center gap-1.5 rounded-full border border-line px-2.5 text-[13px] font-medium text-fg-2">
          {message.origin.cause ? <Eye size={13} className="shrink-0 text-fg-3" /> : <CalendarClock size={13} className="shrink-0 text-fg-3" />}
          <span className="truncate">
            {message.origin.cause
              ? `Watching · ${message.origin.cause.summary}${message.origin.cause.count > 1 ? ` and ${message.origin.cause.count - 1} more` : ""}`
              : `Scheduled · ${message.origin.title}`}
          </span>
        </span>
      ) : null}
      {message.origin?.kind === "voice" ? (
        <span className="inline-flex items-center gap-1 text-[12px] text-fg-3">
          {message.origin.via === "note" ? <Mic size={12} className="shrink-0" /> : <AudioLines size={12} className="shrink-0" />}
          {message.origin.via === "note" ? "Voice message" : "On a call"}
        </span>
      ) : null}
      {message.skill ? (
        <span className="inline-flex h-7 max-w-[min(85%,36rem)] items-center gap-1.5 rounded-full bg-accent-soft px-2.5 text-[13px] font-medium text-accent">
          <Sparkles size={13} className="shrink-0" />
          <span className="truncate">{message.skill.name}</span>
        </span>
      ) : null}
      {message.content ? (
        <div className="flex w-full items-center justify-end gap-1">
          {onEdit ? (
            <div className="opacity-0 transition-opacity duration-200 group-hover/user:opacity-100 focus-within:opacity-100 max-md:opacity-100">
              <IconButton label="Edit message" side="bottom" onClick={() => setEditing(true)} className="size-7">
                <Pencil size={13} />
              </IconButton>
            </div>
          ) : null}
          <div className="max-w-[min(85%,36rem)] rounded-[18px] bg-subtle px-4 py-2.5 text-[15px] leading-[1.6] whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
            {message.content}
          </div>
        </div>
      ) : null}
    </div>
  );
});

function EditBox({ initial, onCancel, onSave }: { initial: string; onCancel: () => void; onSave: (text: string) => void }) {
  const [text, setText] = useState(initial);
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [text]);
  useEffect(() => {
    const el = field.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const changed = text.trim().length > 0 && text.trim() !== initial.trim();
  return (
    <form
      className="ml-auto w-full max-w-[36rem] rounded-[18px] border border-line-strong bg-surface p-3 animate-fade-up"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) onSave(text.trim());
      }}
    >
      <label htmlFor="edit-message" className="sr-only">
        Edit message
      </label>
      <textarea
        id="edit-message"
        ref={field}
        value={text}
        maxLength={MAX_MESSAGE_LENGTH}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && changed) {
            e.preventDefault();
            onSave(text.trim());
          }
        }}
        className="scroll-quiet block w-full resize-none bg-transparent px-1 text-[15px] leading-[1.6] text-fg outline-none"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <span className="mr-auto pl-1 text-[12px] text-fg-3">The reply below will be replaced.</span>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-8 items-center rounded-lg px-3 text-[13px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!changed}
          className="inline-flex h-8 items-center rounded-lg bg-inverse px-3.5 text-[13px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:bg-press disabled:text-fg-4"
        >
          Send
        </button>
      </div>
    </form>
  );
}

interface AssistantProps {
  message: ChatMessage;
  isLast: boolean;
  onRetry: (messageId: string) => void;
  onOpenPanel?: (messageId: string) => void;
  /** Present while the latest reply waits on an approval and can be answered. */
  onDecide?: (approvalId: string, decision: "approve" | "reject", always?: boolean) => void;
  onProposal?: (messageId: string, proposalId: string, decision: "save" | "dismiss" | "undo") => void;
  /** Present while the latest reply's questions or form can be answered; sends the answer as a message. */
  onAnswer?: (text: string, extras?: { attachments: Attachment[] }) => void;
  /** Records what the member did with one of the reply's cards (a form sent, a proposal applied). */
  onUiResponse?: (messageId: string, blockId: string, response: UiResponse) => void;
  onRunTask?: (taskId: string) => Promise<void>;
  /** Present while an offer to call under this reply can be taken: starts the call, resolving with its id. */
  onCall?: () => Promise<string>;
  /** Rates this reply (null clears the rating). */
  onFeedback?: (messageId: string, feedback: MessageFeedback | null) => void;
  /** A notification opened this reply's voice note: its play button is pointed out (it never plays on its own). */
  noteFocus?: boolean;
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  isLast,
  onRetry,
  onOpenPanel,
  onDecide,
  onProposal,
  onAnswer,
  onUiResponse,
  onRunTask,
  onCall,
  onFeedback,
  noteFocus,
}: AssistantProps) {
  const streaming = message.status === "streaming";
  const feedback = message.feedback ?? null;
  const [asking, setAsking] = useState<MessageFeedback["rating"] | null>(null);
  const [thanked, setThanked] = useState(false);
  useEffect(() => {
    if (!thanked) return;
    const timer = setTimeout(() => setThanked(false), 2500);
    return () => clearTimeout(timer);
  }, [thanked]);
  const rate = (rating: MessageFeedback["rating"]) => {
    if (!onFeedback) return;
    setThanked(false);
    if (feedback?.rating === rating) {
      setAsking(null);
      onFeedback(message.id, null);
    } else {
      setAsking(rating);
      onFeedback(message.id, { rating, reasons: [] });
    }
  };
  const hasContent = message.content.trim().length > 0;
  // Show live progress until text arrives, and again whenever the agent starts a new step.
  const working = streaming && (!hasContent || message.activity.some((s) => s.status === "running"));
  // The latest reply carries the agent's mark, showing how things really stand.
  const companion = useCompanion();
  const justFinished = useJustFinished(message.status);
  const presence =
    companion && isLast && !streaming ? (
      <span title={companionHint(companion.stage, companion.name, companion.toMeet)} className="inline-flex size-7 shrink-0 items-center justify-center animate-fade-in">
        <Companion stage={companion.stage} look={companion.look} mood={replyMood(message, justFinished)} size={18} present />
      </span>
    ) : null;

  return (
    <article className="group/message" aria-busy={streaming || undefined}>
      {working || message.activity.length > 0 ? (
        <ActivityLog
          steps={message.activity}
          running={working}
          onOpenPanel={onOpenPanel ? () => onOpenPanel(message.id) : undefined}
        />
      ) : null}

      {/* Requests come before the text: the agent writes its answer after the member decides. */}
      {(message.approvals ?? []).map((approval) => (
        <ThreadApproval
          key={approval.id}
          approval={approval}
          conversationId={message.conversationId}
          onDecide={onDecide && message.status === "awaiting" ? (decision, always) => onDecide(approval.id, decision, always) : undefined}
        />
      ))}

      {/* The voice note comes first; its text twin, the reply, is underneath. */}
      {message.voiceNote && message.status === "complete" ? (
        <div className={message.approvals?.length ? "mt-4" : undefined}>
          <VoiceNote message={message} highlight={noteFocus} />
        </div>
      ) : null}

      {hasContent ? (
        <div className={message.approvals?.length ? "mt-4" : undefined}>
          <Markdown content={message.content} citations={message.citations} />
          {message.citations?.length && !streaming ? <SourceList citations={message.citations} content={message.content} /> : null}
        </div>
      ) : null}

      {/* Charts and tables the agent drew sit in the reply, above any card that asks about them. */}
      {message.timeline?.visuals?.length ? (
        <div className="mt-4 flex flex-col gap-3 [&>figure]:mb-0">
          {message.timeline.visuals.map((visual, i) => (
            <VisualView key={i} visual={visual} />
          ))}
        </div>
      ) : null}

      {message.questions?.length ? (
        <QuestionCard
          questions={message.questions}
          draftKey={`${message.id}:questions`}
          onAnswer={onAnswer && message.status === "complete" ? onAnswer : undefined}
        />
      ) : null}

      {message.ui?.length ? (
        <UiCards
          blocks={message.ui}
          responses={message.uiResponse}
          conversationId={message.conversationId}
          messageId={message.id}
          onAnswer={onAnswer && message.status === "complete" ? onAnswer : undefined}
          onResponse={onUiResponse}
          onRunTask={onRunTask}
          onCall={onCall}
          settled={message.status === "complete"}
        />
      ) : null}

      {message.artifacts.length > 0 ? (
        <div className="mt-4 flex flex-col gap-2">
          {message.artifacts.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))}
        </div>
      ) : null}

      {(message.memoryProposals ?? []).map((proposal) => (
        <MemoryProposalCard
          key={proposal.id}
          proposal={proposal}
          live={streaming}
          onDecide={onProposal && !streaming ? (decision) => onProposal(message.id, proposal.id, decision) : undefined}
        />
      ))}

      {message.status === "error" ? (
        <div role="alert" className="mt-3 flex items-start gap-3 rounded-xl bg-danger-soft py-2.5 pr-2 pl-3.5 animate-fade-up">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-danger" />
          <p className="flex-1 py-px text-[14px] text-fg">{message.error ?? "Something went wrong."}</p>
          <RetryButton onClick={() => onRetry(message.id)} />
        </div>
      ) : null}

      {message.status === "stopped" || message.status === "interrupted" ? (
        <div className="mt-2 flex items-center gap-1 text-[13px] text-fg-3">
          <span>{message.status === "stopped" ? "Stopped" : "This response was interrupted"}</span>
          {/* Retry answers the latest message again, so only the latest reply offers it. */}
          {isLast ? (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => onRetry(message.id)}
                className="rounded px-0.5 font-medium text-fg-2 underline-offset-2 hover:text-fg hover:underline"
              >
                Retry
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {!streaming && hasContent ? (
        <div
          className={`mt-2 -ml-1.5 flex items-center gap-0.5 transition-opacity duration-200 ${
            isLast || feedback || asking ? "opacity-100" : "opacity-0 group-hover/message:opacity-100 focus-within:opacity-100"
          }`}
        >
          {presence}
          <CopyButton text={message.content} />
          {onFeedback ? <FeedbackButtons feedback={feedback} asking={asking} onRate={rate} /> : null}
          {isLast && message.status === "complete" ? (
            <IconButton label="Retry" side="bottom" onClick={() => onRetry(message.id)} className="size-7">
              <RotateCcw size={14} />
            </IconButton>
          ) : null}
          {thanked ? (
            <span role="status" className="ml-1.5 text-[13px] text-fg-3 animate-fade-up">
              Thanks for the feedback
            </span>
          ) : null}
        </div>
      ) : null}

      {presence && !hasContent ? <div className="mt-2 -ml-1.5 flex">{presence}</div> : null}

      {!streaming && asking && feedback?.rating === asking && onFeedback ? (
        <FeedbackReasons
          key={asking}
          feedback={feedback}
          onClose={() => setAsking(null)}
          onSave={(next) => {
            setAsking(null);
            setThanked(true);
            onFeedback(message.id, next);
          }}
        />
      ) : null}
    </article>
  );
});

/**
 * How the agent is, after a reply: waiting on the member, stuck, just done, or at rest
 * (src/lib/chat/move.ts). An offer to call asks nothing of them, so it never reads as waiting.
 */
function replyMood(message: ChatMessage, justFinished: boolean): CompanionMood {
  const { move } = moveOf(message);
  if (move === "your_call") return "needs_you";
  if (move === "stuck") return "stuck";
  return justFinished ? "done" : "idle";
}

const DONE_FOR_MS = 2400;

/** True for a moment after a reply finishes while the member is here (not on load). */
function useJustFinished(status: ChatMessage["status"]): boolean {
  const previous = useRef(status);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    if (was !== "streaming" || status !== "complete") return;
    setDone(true);
    const timer = setTimeout(() => setDone(false), DONE_FOR_MS);
    return () => clearTimeout(timer);
  }, [status]);
  return done;
}

function CopyButton({ text }: { text: string }) {
  const [copied, copy] = useCopy();
  return (
    <IconButton label={copied ? "Copied" : "Copy response"} side="bottom" onClick={() => copy(text)} className="size-7">
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </IconButton>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg"
    >
      <RotateCcw size={13} />
      Retry
    </button>
  );
}

/**
 * A request in the thread. While a call docked over the app is in this conversation, it's the
 * call's to read back and hold too (src/components/voice/call-approvals.ts), and a tap stops the hold.
 */
function ThreadApproval({
  approval,
  conversationId,
  onDecide,
}: {
  approval: Approval;
  conversationId: string;
  onDecide?: (decision: "approve" | "reject", always?: boolean) => void;
}) {
  const onCall = useCallApproval(conversationId, approval.id);
  return (
    <ApprovalCard
      approval={approval}
      conversationId={conversationId}
      onDecide={
        onDecide
          ? (decision, always) => {
              onCall?.onTap();
              onDecide(decision, always);
            }
          : undefined
      }
      call={approval.status === "pending" ? onCall?.call : undefined}
    />
  );
}

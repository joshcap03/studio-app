"use client";

import { AlertCircle, Check, Copy, Pencil, RotateCcw, Sparkles } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { useCopy } from "@/components/ui/use-copy";
import { MAX_MESSAGE_LENGTH, type ChatMessage } from "@/lib/types";
import { ActivityLog } from "./activity";
import { ArtifactCard } from "./artifact-card";
import { AttachmentList } from "./attachments";
import { Markdown } from "./markdown";
import { ApprovalCard, MemoryProposalCard, QuestionCard } from "./requests";

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
  onDecide?: (approvalId: string, decision: "approve" | "reject") => void;
  onProposal?: (messageId: string, proposalId: string, decision: "save" | "dismiss" | "undo") => void;
  /** Present while the latest reply's questions can be answered; sends the answer as a message. */
  onAnswer?: (text: string) => void;
}

export const AssistantMessage = memo(function AssistantMessage({ message, isLast, onRetry, onOpenPanel, onDecide, onProposal, onAnswer }: AssistantProps) {
  const streaming = message.status === "streaming";
  const hasContent = message.content.trim().length > 0;
  // Show live progress until text arrives, and again whenever the agent starts a new step.
  const working = streaming && (!hasContent || message.activity.some((s) => s.status === "running"));

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
        <ApprovalCard
          key={approval.id}
          approval={approval}
          onDecide={onDecide && message.status === "awaiting" ? (decision) => onDecide(approval.id, decision) : undefined}
        />
      ))}

      {hasContent ? (
        <div className={message.approvals?.length ? "mt-4" : undefined}>
          <Markdown content={message.content} />
        </div>
      ) : null}

      {message.questions?.length ? (
        <QuestionCard questions={message.questions} onAnswer={onAnswer && message.status === "complete" ? onAnswer : undefined} />
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
            isLast ? "opacity-100" : "opacity-0 group-hover/message:opacity-100 focus-within:opacity-100"
          }`}
        >
          <CopyButton text={message.content} />
          {isLast && message.status === "complete" ? (
            <IconButton label="Retry" side="bottom" onClick={() => onRetry(message.id)} className="size-7">
              <RotateCcw size={14} />
            </IconButton>
          ) : null}
        </div>
      ) : null}
    </article>
  );
});

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

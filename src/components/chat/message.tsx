"use client";

import { AlertCircle, Check, Copy, RotateCcw, Sparkles } from "lucide-react";
import { memo } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { useCopy } from "@/components/ui/use-copy";
import type { ChatMessage } from "@/lib/types";
import { ActivityLog } from "./activity";
import { ArtifactCard } from "./artifact-card";
import { Markdown } from "./markdown";

export const UserMessage = memo(function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="flex justify-end animate-fade-up">
      <div className="flex max-w-[min(85%,36rem)] flex-col items-end gap-1.5">
        {message.skill ? (
          <span className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-accent-soft px-2.5 text-[13px] font-medium text-accent">
            <Sparkles size={13} className="shrink-0" />
            <span className="truncate">{message.skill.name}</span>
          </span>
        ) : null}
        {message.content ? (
          <div className="rounded-[18px] bg-subtle px-4 py-2.5 text-[15px] leading-[1.6] whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
            {message.content}
          </div>
        ) : null}
      </div>
    </div>
  );
});

interface AssistantProps {
  message: ChatMessage;
  isLast: boolean;
  onRetry: (messageId: string) => void;
  onOpenPanel?: (messageId: string) => void;
}

export const AssistantMessage = memo(function AssistantMessage({ message, isLast, onRetry, onOpenPanel }: AssistantProps) {
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

      {hasContent ? <Markdown content={message.content} /> : null}

      {message.artifacts.length > 0 ? (
        <div className="mt-4 flex flex-col gap-2">
          {message.artifacts.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))}
        </div>
      ) : null}

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
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() => onRetry(message.id)}
            className="rounded px-0.5 font-medium text-fg-2 underline-offset-2 hover:text-fg hover:underline"
          >
            Retry
          </button>
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

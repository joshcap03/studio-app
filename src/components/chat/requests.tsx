"use client";

import { Ban, BookmarkCheck, BookmarkPlus, Check, Clock, X } from "lucide-react";
import { useState } from "react";
import { appName } from "@/lib/apps";
import type { Approval, MemoryProposal } from "@/lib/types";
import { AppGlyph } from "./app-glyph";

// Cards for what the agent asked of the member: an action to approve before it runs, and a
// fact to remember. Rendered only from what the backend reported; nothing here acts until
// the member clicks.

interface ApprovalProps {
  approval: Approval;
  /** Present only while this request can still be answered. */
  onDecide?: (decision: "approve" | "reject") => void;
}

export function ApprovalCard({ approval, onDecide }: ApprovalProps) {
  const pending = approval.status === "pending";
  const [choice, setChoice] = useState<"approve" | "reject" | null>(null);

  function decide(decision: "approve" | "reject") {
    if (!onDecide || choice) return;
    setChoice(decision);
    onDecide(decision);
  }

  return (
    <section
      aria-label="Action waiting for approval"
      className={`mt-4 overflow-hidden rounded-xl border animate-fade-up ${pending ? "border-line-strong bg-surface shadow-composer" : "border-line bg-transparent"}`}
    >
      <div className="flex items-start gap-3 px-4 pt-3.5 pb-3">
        <AppGlyph app={approval.app} size={20} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium tracking-[0.01em] text-fg-3">
            {pending ? "Needs your OK" : "Asked for your OK"}
            {approval.app ? ` · ${appName(approval.app)}` : ""}
          </p>
          <p className="mt-0.5 text-[15px] leading-[1.5] text-fg [overflow-wrap:anywhere]">{approval.summary}</p>
        </div>
      </div>

      {approval.details.length > 0 ? (
        <dl className="mx-4 mb-3 grid grid-cols-[minmax(4.5rem,auto)_1fr] gap-x-3 gap-y-1.5 rounded-lg bg-subtle px-3 py-2.5 text-[13px]">
          {approval.details.map(([label, value], i) => (
            <div key={i} className="contents">
              <dt className="text-fg-3">{label}</dt>
              <dd className="max-h-32 min-w-0 overflow-y-auto whitespace-pre-wrap text-fg-2 [overflow-wrap:anywhere]">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {pending && onDecide ? (
        <div className="flex items-center justify-end gap-2 border-t border-line px-3 py-2.5">
          <span className="mr-auto pl-1 text-[12px] text-fg-3">Nothing happens until you choose.</span>
          <button
            type="button"
            onClick={() => decide("reject")}
            disabled={choice !== null}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
          >
            <X size={14} />
            Decline
          </button>
          <button
            type="button"
            onClick={() => decide("approve")}
            disabled={choice !== null}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-inverse px-3.5 text-[13px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {choice === "approve" ? <span className="spinner size-3.5" aria-hidden="true" /> : <Check size={14} />}
            Approve
          </button>
        </div>
      ) : (
        <ApprovalOutcome status={approval.status} />
      )}
    </section>
  );
}

function ApprovalOutcome({ status }: { status: Approval["status"] }) {
  const outcome =
    status === "approved"
      ? { icon: Check, text: "You approved this", tone: "text-success" }
      : status === "declined"
        ? { icon: Ban, text: "You declined this, so it didn't happen", tone: "text-fg-3" }
        : status === "expired"
          ? { icon: Clock, text: "Expired before it was answered, so nothing was done", tone: "text-fg-3" }
          : { icon: Clock, text: "Waiting for your answer", tone: "text-fg-3" };
  const Icon = outcome.icon;
  return (
    <p className={`flex items-center gap-1.5 border-t border-line px-4 py-2 text-[12.5px] ${outcome.tone}`}>
      <Icon size={13} />
      {outcome.text}
    </p>
  );
}

interface ProposalProps {
  proposal: MemoryProposal;
  onDecide?: (decision: "save" | "dismiss" | "undo") => void;
}

const quiet = "inline-flex h-6 items-center rounded-md px-1.5 text-[12.5px] font-medium text-fg-3 transition-colors hover:bg-hover hover:text-fg";

/**
 * Something the agent remembered. Saved ones are a quiet line with Undo; one that couldn't be
 * saved asks the member instead.
 */
export function MemoryProposalCard({ proposal, onDecide }: ProposalProps) {
  const where = proposal.scope === "personal" ? "for you" : "for the workspace";
  if (proposal.status !== "pending") {
    const saved = proposal.status === "saved";
    return (
      <section aria-label={saved ? "Remembered" : "Not remembered"} className="mt-2 flex items-start gap-2 text-[13px] animate-fade-up">
        {saved ? (
          <BookmarkCheck size={14} className="mt-[3px] shrink-0 text-success" />
        ) : (
          <BookmarkPlus size={14} className="mt-[3px] shrink-0 text-fg-4" />
        )}
        <p className="min-w-0 flex-1 leading-[1.5] text-fg-3 [overflow-wrap:anywhere]">
          <span className="font-medium text-fg-2">{saved ? `Remembered ${where}` : "Not remembered"}</span>
          <span className="mx-1.5 text-fg-4">·</span>
          <span className={saved ? undefined : "line-through"}>{proposal.content}</span>
        </p>
        {onDecide ? (
          <button type="button" onClick={() => onDecide(saved ? "undo" : "save")} className={`${quiet} -mt-0.5 shrink-0`}>
            {saved ? "Undo" : "Remember"}
          </button>
        ) : null}
      </section>
    );
  }
  return (
    <section
      aria-label="Suggested memory"
      className="mt-3 flex items-start gap-3 rounded-xl border border-line px-3.5 py-3 animate-fade-up"
    >
      <BookmarkPlus size={17} className="mt-0.5 shrink-0 text-fg-3" />
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-medium text-fg-3">Remember this {where}?</p>
        <p className="mt-0.5 text-[14px] leading-[1.5] text-fg [overflow-wrap:anywhere]">{proposal.content}</p>
      </div>
      {onDecide ? (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onDecide("dismiss")}
            className="inline-flex h-7 items-center rounded-lg px-2.5 text-[13px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg"
          >
            Dismiss
          </button>
          <button
            type="button"
            onClick={() => onDecide("save")}
            className="inline-flex h-7 items-center rounded-lg bg-inverse px-2.5 text-[13px] font-medium text-on-inverse transition-opacity hover:opacity-90"
          >
            Save
          </button>
        </div>
      ) : null}
    </section>
  );
}

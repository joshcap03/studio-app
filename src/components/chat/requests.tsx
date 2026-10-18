"use client";

import { ArrowUp, Ban, BookmarkCheck, BookmarkPlus, Check, Clock, MessageCircleQuestion, X } from "lucide-react";
import { useState } from "react";
import { appName } from "@/lib/apps";
import type { Approval, MemoryProposal, Question } from "@/lib/types";
import { AppGlyph } from "./app-glyph";
import { useCardDrafts } from "./card-drafts";
import { Heard } from "./ui-cards";

export { answerText } from "./card-drafts";

// Cards for what the agent asked of the member: an action to approve before it runs, a
// question to answer, and a fact to remember. Rendered only from what the backend reported; nothing here acts until
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
  const where = proposal.scope === "personal" ? " for you" : "";
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
          <span className="font-medium text-fg-2">{saved ? `Remembered${where}` : "Not remembered"}</span>
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
        <p className="text-[12px] font-medium text-fg-3">Remember this{where}?</p>
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

interface QuestionsProps {
  questions: Question[];
  /** Present only while these can still be answered (the latest reply, agent idle). */
  onAnswer?: (text: string) => void;
  /** Where the picks are kept in the workspace's card drafts (shared with a call's stage). */
  draftKey: string;
}

/**
 * Questions the agent asked, with choices to click. One single-choice question sends on
 * click; otherwise the member picks for each and sends. Typing in the composer answers too.
 */
export function QuestionCard({ questions, onAnswer, draftKey }: QuestionsProps) {
  const drafts = useCardDrafts();
  const { picks, sent, heard } = drafts.question(draftKey, questions);
  const instant = questions.length === 1 && !questions[0].multiSelect;
  const complete = picks.every((p) => p.length > 0);

  if (!onAnswer || sent) {
    return (
      <section aria-label="Question from the agent" className="mt-3 flex flex-col gap-1 animate-fade-up">
        {questions.map((q, i) => (
          <p key={i} className="flex items-start gap-2 text-[13px] leading-[1.5] text-fg-3">
            <MessageCircleQuestion size={14} className="mt-[3px] shrink-0 text-fg-4" />
            <span className="min-w-0 [overflow-wrap:anywhere]">{q.question}</span>
          </p>
        ))}
      </section>
    );
  }

  const answer = onAnswer;
  const setPicks = (next: string[][]) => drafts.updateQuestion(draftKey, questions, (d) => ({ ...d, picks: next, heard: null }));

  function submit(next: string[][]) {
    if (sent || !next.every((p) => p.length > 0)) return;
    setPicks(next);
    drafts.submitQuestions(draftKey, questions, answer);
  }

  function pick(qi: number, label: string) {
    const q = questions[qi];
    const current = picks[qi];
    const value = q.multiSelect ? (current.includes(label) ? current.filter((l) => l !== label) : [...current, label]) : [label];
    const next = picks.map((p, i) => (i === qi ? value : p));
    setPicks(next);
    if (instant) submit(next);
  }

  return (
    <section
      aria-label="Question from the agent"
      className="mt-4 overflow-hidden rounded-xl border border-line-strong bg-surface shadow-composer animate-fade-up"
    >
      {questions.map((q, qi) => (
        <fieldset key={qi} className={`px-3 pt-3.5 pb-3 ${qi > 0 ? "border-t border-line" : ""}`}>
          <legend className="contents">
            <span className="block px-1 text-[12px] font-medium tracking-[0.01em] text-fg-3">
              {q.header || "Question"}
              {q.multiSelect ? " · Pick any" : ""}
            </span>
            <span className="mt-0.5 block px-1 text-[15px] leading-[1.5] text-fg [overflow-wrap:anywhere]">{q.question}</span>
          </legend>
          <div className="mt-2.5 flex flex-col gap-1">
            {q.options.map((option, oi) => {
              const chosen = picks[qi].includes(option.label);
              return (
                <button
                  key={oi}
                  type="button"
                  role={q.multiSelect ? "checkbox" : "radio"}
                  aria-checked={chosen}
                  onClick={() => pick(qi, option.label)}
                  className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                    chosen ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong hover:bg-hover"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`mt-[3px] flex size-[18px] shrink-0 items-center justify-center text-[11px] font-medium ${
                      q.multiSelect ? "rounded-[5px]" : "rounded-full"
                    } ${chosen ? "bg-accent text-on-inverse" : "border border-line-strong text-fg-3"}`}
                  >
                    {chosen ? <Check size={12} strokeWidth={2.5} /> : q.multiSelect ? null : oi + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] leading-[1.5] font-medium text-fg [overflow-wrap:anywhere]">{option.label}</span>
                    {option.description ? (
                      <span className="block text-[13px] leading-[1.45] text-fg-3 [overflow-wrap:anywhere]">{option.description}</span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}
      {heard ? (
        <div className="px-3 pb-3">
          <Heard said={heard.said} onUse={() => (instant ? submit(heard.picks) : setPicks(heard.picks))} onDismiss={() => drafts.updateQuestion(draftKey, questions, (d) => ({ ...d, heard: null }))} />
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-2 border-t border-line px-3 py-2.5">
        <span className="mr-auto pl-1 text-[12px] text-fg-3">Or type your own answer below.</span>
        {/* One single-choice question sends on a tap; picked by voice, it waits for Send. */}
        {instant && !complete ? null : (
          <button
            type="button"
            onClick={() => submit(picks)}
            disabled={!complete}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-inverse px-3.5 text-[13px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:bg-press disabled:text-fg-4"
          >
            <ArrowUp size={14} />
            Send
          </button>
        )}
      </div>
    </section>
  );
}

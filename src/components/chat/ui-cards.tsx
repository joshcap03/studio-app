"use client";

import { ArrowUp, AudioLines, Check, ChevronDown, ChevronUp, ClipboardList, ExternalLink, FileUp, GripVertical, Paperclip, Plug, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { appName, toolkitForApp } from "@/lib/apps";
import type { FormValues } from "@/lib/chat/ui-answer";
import { api, ApiError, uploadAttachment } from "@/lib/client/api";
import { catalogEntry } from "@/lib/skills/catalog";
import { describeSchedule } from "@/lib/tasks/schedule";
import type { AgentProposal, Attachment, ConnectionsState, ProposalPicks, UiBlock, UiField, UiForm, UiResponse } from "@/lib/types";
import { ATTACHMENT_TYPES } from "@/lib/types";
import { AppGlyph } from "./app-glyph";
import { useCardDrafts, type FormDraft } from "./card-drafts";

// Reusable cards for what the agent asks through its show_form and propose_agent tools. They
// know nothing about any one flow (setup, a template): every field kind and proposal item is
// generic, and any skill can use them. Rendered only from what the backend reported; nothing
// here acts until the member clicks.

export interface UiCardsProps {
  blocks: UiBlock[];
  responses: Record<string, UiResponse> | null | undefined;
  conversationId: string;
  messageId: string;
  /** Present while a form can still be sent (the latest reply, agent idle). */
  onAnswer?: (text: string, extras: { attachments: Attachment[] }) => void;
  /** Records what the member did with a card, once the server has saved it. */
  onResponse?: (messageId: string, blockId: string, response: UiResponse) => void;
  /** Whether the reply is finished, so a proposal can be applied. */
  settled: boolean;
  /** Runs a task now and opens its conversation; throws with a message the card can show. */
  onRunTask?: (taskId: string) => Promise<void>;
}

export function UiCards({ blocks, responses, conversationId, messageId, onAnswer, onResponse, settled, onRunTask }: UiCardsProps) {
  return (
    <>
      {blocks.map((block) =>
        block.kind === "form" ? (
          <FormCard
            key={block.id}
            form={block}
            response={responses?.[block.id]}
            onAnswer={onAnswer}
            conversationId={conversationId}
            messageId={messageId}
            onResponse={onResponse}
          />
        ) : (
          <ProposalCard
            key={block.id}
            proposal={block}
            response={responses?.[block.id]}
            canApply={settled && Boolean(onResponse)}
            onRunTask={onRunTask}
            onApply={async (picks, edits) => {
              const { response } = await api.answerUi(conversationId, block.id, {
                action: "apply",
                picks,
                edits,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              });
              onResponse?.(messageId, block.id, response);
            }}
          />
        ),
      )}
    </>
  );
}

const card = "mt-4 overflow-hidden rounded-xl border border-line-strong bg-surface shadow-composer animate-fade-up";
const input =
  "w-full rounded-lg border border-line bg-transparent px-3 py-2 text-[14px] leading-[1.5] text-fg placeholder:text-fg-4 focus:border-line-strong focus:outline-none";
const primary =
  "inline-flex h-8 items-center gap-1.5 rounded-lg bg-inverse px-3.5 text-[13px] font-medium text-on-inverse transition-opacity hover:opacity-90 disabled:bg-press disabled:text-fg-4";
const quiet = "inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] font-medium text-fg-3 transition-colors hover:bg-hover hover:text-fg";

interface FormProps {
  form: UiForm;
  response?: UiResponse;
  onAnswer?: UiCardsProps["onAnswer"];
  conversationId: string;
  messageId: string;
  onResponse?: UiCardsProps["onResponse"];
}

/**
 * A form the agent asked the member to fill in. Its answers go out as their next message. What's
 * filled in lives in the workspace's card drafts, so on a call the card on the stage is this one.
 */
export function FormCard({ form, response, onAnswer, conversationId, messageId, onResponse }: FormProps) {
  const drafts = useCardDrafts();
  const { values, files, uploading, error, sent, busy, heard } = drafts.form(form);
  const update = (fn: (d: FormDraft) => FormDraft) => drafts.updateForm(form, fn);

  if (!onAnswer || sent || response) {
    const answered = sent || response?.status === "submitted";
    return (
      <section aria-label="Form from the agent" className="mt-3 flex items-start gap-2 text-[13px] leading-[1.5] text-fg-3 animate-fade-up">
        {answered ? <Check size={14} className="settle-check mt-[3px] shrink-0 text-success" /> : <ClipboardList size={14} className="mt-[3px] shrink-0 text-fg-4" />}
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {form.title}
          {answered ? <span className="text-fg-4"> · Sent</span> : null}
        </span>
      </section>
    );
  }

  const set = (id: string, value: FormValues[string]) =>
    update((d) => {
      const { [id]: _, ...stillHeard } = d.heard;
      return { ...d, error: null, values: { ...d.values, [id]: value }, heard: stillHeard };
    });
  const answer = onAnswer;

  function submit() {
    void drafts.submitForm({ form, conversationId, messageId, onAnswer: answer, onResponse });
  }

  return (
    <section
      aria-label="Form from the agent"
      className={card}
      onKeyDown={(e) => {
        // Cmd/Ctrl+Enter sends from anywhere in the form.
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <div className="px-4 pt-3.5">
        <p className="text-[12px] font-medium tracking-[0.01em] text-fg-3">{form.title}</p>
        {form.intro ? <p className="mt-0.5 text-[14px] leading-[1.5] text-fg-2 [overflow-wrap:anywhere]">{form.intro}</p> : null}
      </div>
      <div className="flex flex-col gap-4 px-4 pt-3 pb-4">
        {form.fields.map((field) => (
          <div key={field.id} className="flex flex-col gap-2">
            <FieldView
              field={field}
              value={values[field.id]}
              files={files[field.id] ?? []}
              onChange={(v) => set(field.id, v)}
              onFiles={(list) => update((d) => ({ ...d, files: { ...d.files, [field.id]: list } }))}
              onUploading={(delta) => update((d) => ({ ...d, uploading: d.uploading + delta }))}
              onError={(message) => update((d) => ({ ...d, error: message }))}
            />
            {heard[field.id] ? (
              <Heard
                said={heard[field.id].said}
                onUse={() => set(field.id, heard[field.id].value)}
                onDismiss={() =>
                  update((d) => {
                    const { [field.id]: _, ...rest } = d.heard;
                    return { ...d, heard: rest };
                  })
                }
              />
            ) : null}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line px-3 py-2.5">
        <span className={`mr-auto pl-1 text-[12px] ${error ? "text-danger" : "text-fg-3"}`}>{error ?? formProgress(form, values) ?? "Or type your own answer below."}</span>
        <button type="button" onClick={submit} disabled={uploading > 0 || busy} className={primary}>
          {uploading > 0 || busy ? <span className="spinner size-3.5" aria-hidden="true" /> : <ArrowUp size={14} />}
          {form.submitLabel}
        </button>
      </div>
    </section>
  );
}

/**
 * An answer heard on a call that only loosely matched, or isn't quite what the member said:
 * nothing changes until they tap "Use it".
 */
export function Heard({ said, onUse, onDismiss }: { said: string; onUse: () => void; onDismiss: () => void }) {
  return (
    <div role="status" className="flex items-center gap-1.5 rounded-lg bg-accent-soft py-1 pr-1 pl-2.5 text-[12.5px] leading-[1.45] text-fg-2 animate-fade-in">
      <AudioLines size={13} className="shrink-0 text-accent" aria-hidden="true" />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">Heard: {said}?</span>
      <button type="button" onClick={onUse} className={quiet}>
        Use it
      </button>
      <button type="button" aria-label="Not that" onClick={onDismiss} className={`${quiet} px-1.5`}>
        <X size={13} />
      </button>
    </div>
  );
}

interface FieldProps {
  field: UiField;
  value: FormValues[string] | undefined;
  files: Attachment[];
  onChange: (value: FormValues[string]) => void;
  onFiles: (files: Attachment[]) => void;
  onUploading: (delta: number) => void;
  onError: (message: string) => void;
}

function FieldView({ field, value, files, onChange, onFiles, onUploading, onError }: FieldProps) {
  const label = (
    <span className="block">
      <span className="text-[14px] font-medium text-fg">{field.label}</span>
      {field.required || field.kind === "connect" || field.kind === "rank" ? null : <span className="text-[12px] text-fg-4"> · Optional</span>}
      {field.help ? <span className="mt-0.5 block text-[12.5px] leading-[1.45] text-fg-3">{field.help}</span> : null}
    </span>
  );
  switch (field.kind) {
    case "choice":
    case "multi_choice":
      return <ChoiceField field={field} label={label} value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} />;
    case "rank":
      return <RankField field={field} label={label} value={Array.isArray(value) ? (value as string[]) : field.options.map((o) => o.label)} onChange={onChange} />;
    case "scale":
      return <ScaleField field={field} label={label} value={typeof value === "string" ? Number(value) : 0} onChange={(n) => onChange(String(n))} />;
    case "verdict":
      return <VerdictField field={field} label={label} value={Array.isArray(value) ? (value as Record<string, string>[]) : []} onChange={onChange} />;
    case "text":
    case "long_text":
      return (
        <label className="block">
          {label}
          {field.kind === "text" ? (
            <input
              className={`${input} mt-1.5`}
              value={typeof value === "string" ? value : ""}
              placeholder={field.placeholder}
              maxLength={500}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <textarea
              className={`${input} mt-1.5 min-h-20 resize-y`}
              value={typeof value === "string" ? value : ""}
              placeholder={field.placeholder}
              maxLength={4000}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        </label>
      );
    case "file":
      return <FileField field={field} label={label} files={files} onFiles={onFiles} onUploading={onUploading} onError={onError} />;
    case "list":
      return <ListField field={field} label={label} value={Array.isArray(value) ? (value as Record<string, string>[]) : [{}]} onChange={onChange} />;
    case "connect":
      return <ConnectField field={field} label={label} />;
  }
}

/** A quiet running count for forms where the member judges results, e.g. "3 of 5 judged · 2 kept". */
function formProgress(form: UiForm, values: FormValues): string | null {
  const verdicts = form.fields.filter((f) => f.kind === "verdict");
  if (verdicts.length === 0) return null;
  const total = verdicts.reduce((n, f) => n + f.items.length, 0);
  const calls = verdicts.flatMap((f) => (Array.isArray(values[f.id]) ? (values[f.id] as Record<string, string>[]) : []));
  const kept = calls.filter((c) => c.verdict === "keep").length;
  const judged = calls.filter((c) => c.verdict).length;
  return judged ? `${judged} of ${total} judged · ${kept} kept` : `Keep or pass on each of the ${total}.`;
}

const tile = (chosen: boolean) =>
  `inline-flex min-h-8 items-center gap-1.5 rounded-lg border px-3 py-1 text-[13.5px] transition-[background-color,border-color,transform] duration-150 active:scale-[0.97] ${
    chosen ? "border-accent bg-accent-soft text-fg" : "border-line text-fg-2 hover:border-line-strong hover:bg-hover"
  }`;

/** Pick one or several; number keys pick while the group has focus. "Something else" takes their own words. */
function ChoiceField({
  field,
  label,
  value,
  onChange,
}: {
  field: Extract<UiField, { kind: "choice" | "multi_choice" }>;
  label: React.ReactNode;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const multi = field.kind === "multi_choice";
  const labels = new Set(field.options.map((o) => o.label));
  const own = value.find((v) => !labels.has(v));
  const [otherOpen, setOther] = useState(own !== undefined);
  // Their own words can also arrive by voice while the card is open.
  const other = otherOpen || own !== undefined;
  const toggle = (l: string) => {
    const chosen = value.includes(l);
    onChange(multi ? (chosen ? value.filter((x) => x !== l) : [...value, l]) : chosen ? [] : [l]);
  };
  const setOwn = (text: string) => {
    const rest = multi ? value.filter((v) => labels.has(v)) : [];
    onChange(text.trim() ? [...rest, text] : rest);
  };
  return (
    <fieldset
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
        const n = Number.parseInt(e.key, 10);
        if (n >= 1 && n <= field.options.length) {
          e.preventDefault();
          if (!multi) setOther(false);
          toggle(field.options[n - 1].label);
        }
      }}
    >
      <legend className="contents">{label}</legend>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {field.options.map((o, i) => {
          const chosen = value.includes(o.label);
          return (
            <button
              key={o.label}
              type="button"
              role={multi ? "checkbox" : "radio"}
              aria-checked={chosen}
              aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
              title={o.description}
              onClick={() => {
                if (!multi) setOther(false);
                toggle(o.label);
              }}
              className={tile(chosen)}
            >
              {chosen ? <Check size={13} strokeWidth={2.5} className="settle-check text-accent" /> : null}
              {o.label}
            </button>
          );
        })}
        {field.allowOther && !other ? (
          <button
            type="button"
            onClick={() => {
              setOther(true);
              if (!multi) onChange([]);
            }}
            className={`${tile(false)} border-dashed text-fg-3`}
          >
            <Plus size={13} />
            Something else
          </button>
        ) : null}
      </div>
      {field.allowOther && other ? (
        <div className="mt-1.5 flex items-center gap-1.5 animate-fade-in">
          <input
            autoFocus
            className={input}
            value={own ?? ""}
            placeholder="In your own words"
            maxLength={200}
            onChange={(e) => setOwn(e.target.value)}
          />
          <button
            type="button"
            aria-label="Never mind"
            onClick={() => {
              setOther(false);
              setOwn("");
            }}
            className={quiet}
          >
            <X size={13} />
          </button>
        </div>
      ) : null}
    </fieldset>
  );
}

/** Put options in order, most important first: drag a row, or focus it and use the arrow keys. */
function RankField({
  field,
  label,
  value,
  onChange,
}: {
  field: Extract<UiField, { kind: "rank" }>;
  label: React.ReactNode;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const rows = useRef<(HTMLLIElement | null)[]>([]);
  const describe = new Map(field.options.map((o) => [o.label, o.description]));
  function move(from: number, to: number, focus = false) {
    if (to < 0 || to >= value.length || from === to) return;
    const next = [...value];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
    setMoved(item);
    if (focus) requestAnimationFrame(() => rows.current[to]?.focus());
  }
  return (
    <div>
      {label}
      <ol className="mt-2 flex flex-col gap-1" aria-label={field.label}>
        {value.map((item, i) => (
          <li
            key={item}
            ref={(el) => {
              rows.current[i] = el;
            }}
            tabIndex={0}
            draggable
            aria-label={`${i + 1}. ${item}. Use the up and down arrow keys to move it.`}
            onDragStart={() => setDragging(i)}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragging !== null && dragging !== i) {
                move(dragging, i);
                setDragging(i);
              }
            }}
            onDragEnd={() => setDragging(null)}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                move(i, i + (e.key === "ArrowUp" ? -1 : 1), true);
              }
            }}
            className={`group flex cursor-grab items-center gap-2.5 rounded-lg border px-2.5 py-2 text-[13.5px] transition-[background-color,border-color,opacity] duration-150 focus:outline-none focus-visible:border-line-strong active:cursor-grabbing ${
              dragging === i ? "border-line-strong bg-subtle opacity-70" : moved === item ? "border-line-strong animate-landed" : "border-line"
            }`}
            onAnimationEnd={() => setMoved(null)}
          >
            <span className="w-4 shrink-0 text-center font-mono text-[12px] tabular-nums text-fg-3">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="text-fg">{item}</span>
              {describe.get(item) ? <span className="block text-[12.5px] leading-[1.45] text-fg-3">{describe.get(item)}</span> : null}
            </span>
            <span className="flex shrink-0 items-center opacity-60 transition-opacity group-hover:opacity-100">
              <button type="button" tabIndex={-1} aria-label={`Move ${item} up`} disabled={i === 0} onClick={() => move(i, i - 1)} className={`${quiet} px-1 disabled:opacity-30`}>
                <ChevronUp size={14} />
              </button>
              <button type="button" tabIndex={-1} aria-label={`Move ${item} down`} disabled={i === value.length - 1} onClick={() => move(i, i + 1)} className={`${quiet} px-1 disabled:opacity-30`}>
                <ChevronDown size={14} />
              </button>
              <GripVertical size={14} className="text-fg-4" aria-hidden="true" />
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** One point on a short scale between two labelled ends. */
function ScaleField({
  field,
  label,
  value,
  onChange,
}: {
  field: Extract<UiField, { kind: "scale" }>;
  label: React.ReactNode;
  value: number;
  onChange: (value: number) => void;
}) {
  const points = Array.from({ length: field.steps }, (_, i) => i + 1);
  return (
    <fieldset>
      <legend className="contents">{label}</legend>
      <div
        role="radiogroup"
        aria-label={field.label}
        className="mt-2 grid gap-1"
        style={{ gridTemplateColumns: `repeat(${field.steps}, minmax(0, 1fr))` }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            const next = Math.min(field.steps, Math.max(1, (value || Math.ceil(field.steps / 2)) + (e.key === "ArrowRight" ? 1 : -1)));
            onChange(next);
            (e.currentTarget.children[next - 1] as HTMLElement | undefined)?.focus();
          }
        }}
      >
        {points.map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} of ${field.steps}`}
            tabIndex={value === n || (!value && n === 1) ? 0 : -1}
            onClick={() => onChange(n)}
            className={`h-8 rounded-md border text-[13px] tabular-nums transition-[background-color,border-color,transform] duration-150 active:scale-[0.97] ${
              value === n ? "border-accent bg-accent-soft text-fg" : value && n < value ? "border-line bg-subtle text-fg-3" : "border-line text-fg-3 hover:bg-hover"
            }`}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-between gap-4 text-[12px] leading-[1.4] text-fg-3">
        <span>{field.low}</span>
        <span className="text-right">{field.high}</span>
      </div>
    </fieldset>
  );
}

/** Results to keep or pass on; a pass can say why, from the agent's suggested reasons or the member's own. */
function VerdictField({
  field,
  label,
  value,
  onChange,
}: {
  field: Extract<UiField, { kind: "verdict" }>;
  label: React.ReactNode;
  value: Record<string, string>[];
  onChange: (value: Record<string, string>[]) => void;
}) {
  const callOf = (id: string) => value.find((v) => v.id === id);
  const put = (id: string, patch: Record<string, string>) => {
    const current = callOf(id) ?? { id };
    const next = { ...current, ...patch };
    onChange([...value.filter((v) => v.id !== id), next]);
  };
  return (
    <div>
      {label}
      <ul className="mt-2 flex flex-col gap-1.5">
        {field.items.map((item) => {
          const call = callOf(item.id);
          const verdict = call?.verdict;
          return (
            <li
              key={item.id}
              tabIndex={-1}
              onKeyDown={(e) => {
                if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
                if (e.key === "k") put(item.id, { verdict: "keep", reason: "" });
                if (e.key === "p") put(item.id, { verdict: "pass" });
              }}
              className={`rounded-lg border px-3 py-2.5 transition-[background-color,border-color,opacity] duration-200 ${
                verdict === "keep" ? "border-accent bg-accent-soft" : verdict === "pass" ? "border-line bg-subtle" : "border-line"
              }`}
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
                <div className={`min-w-0 flex-1 transition-opacity duration-200 ${verdict === "pass" ? "opacity-60" : ""}`}>
                  <p className="text-[13.5px] font-medium leading-[1.45] text-fg [overflow-wrap:anywhere]">
                    {item.link ? (
                      <a href={item.link} target="_blank" rel="noreferrer" className="inline-flex items-baseline gap-1 hover:underline">
                        {item.title}
                        <ExternalLink size={11} className="shrink-0 translate-y-[1px] text-fg-4" />
                      </a>
                    ) : (
                      item.title
                    )}
                  </p>
                  {item.body ? <p className="mt-0.5 text-[12.5px] leading-[1.5] text-fg-3 [overflow-wrap:anywhere]">{item.body}</p> : null}
                </div>
                <div className="flex shrink-0 gap-1" role="radiogroup" aria-label={`Keep or pass on ${item.title}`}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={verdict === "keep"}
                    aria-keyshortcuts="k"
                    onClick={() => put(item.id, verdict === "keep" ? { verdict: "" } : { verdict: "keep", reason: "" })}
                    className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[12.5px] font-medium transition-[background-color,border-color,transform] duration-150 active:scale-[0.96] ${
                      verdict === "keep" ? "border-accent bg-surface text-fg" : "border-line text-fg-3 hover:bg-hover hover:text-fg"
                    }`}
                  >
                    <Check size={13} strokeWidth={verdict === "keep" ? 2.5 : 2} className={verdict === "keep" ? "settle-check text-accent" : ""} />
                    Keep
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={verdict === "pass"}
                    aria-keyshortcuts="p"
                    onClick={() => put(item.id, verdict === "pass" ? { verdict: "" } : { verdict: "pass" })}
                    className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[12.5px] font-medium transition-[background-color,border-color,transform] duration-150 active:scale-[0.96] ${
                      verdict === "pass" ? "border-line-strong bg-surface text-fg" : "border-line text-fg-3 hover:bg-hover hover:text-fg"
                    }`}
                  >
                    <X size={13} />
                    Pass
                  </button>
                </div>
              </div>
              {verdict === "pass" ? (
                <div className="mt-2 flex flex-wrap items-center gap-1 animate-fade-in">
                  <span className="mr-0.5 text-[12px] text-fg-3">Why?</span>
                  {field.reasons.map((r) => (
                    <button
                      key={r}
                      type="button"
                      aria-pressed={call?.reason === r}
                      onClick={() => put(item.id, { reason: call?.reason === r ? "" : r })}
                      className={`h-6 rounded-md border px-2 text-[12px] transition-colors ${
                        call?.reason === r ? "border-line-strong bg-surface text-fg" : "border-line text-fg-3 hover:bg-hover hover:text-fg"
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                  <input
                    className="h-6 min-w-32 flex-1 rounded-md border border-line bg-transparent px-2 text-[12px] text-fg placeholder:text-fg-4 focus:border-line-strong focus:outline-none"
                    placeholder={field.reasons.length ? "Or say why" : "Say why (optional)"}
                    maxLength={200}
                    value={call?.reason && !field.reasons.includes(call.reason) ? call.reason : ""}
                    onChange={(e) => put(item.id, { reason: e.target.value })}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FileField({
  field,
  label,
  files,
  onFiles,
  onUploading,
  onError,
}: Omit<FieldProps, "value" | "onChange" | "field"> & { field: Extract<UiField, { kind: "file" }>; label: React.ReactNode }) {
  const picker = useRef<HTMLInputElement>(null);
  const latest = useRef(files);
  latest.current = files;
  async function add(list: FileList | null) {
    if (!list) return;
    for (const file of Array.from(list).slice(0, field.max - latest.current.length)) {
      // A drop skips the picker's filter.
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (!field.accept.includes(ext)) {
        onError(`${file.name} isn't a ${field.accept.map((e) => e.toUpperCase()).join(" or ")} file.`);
        continue;
      }
      onUploading(1);
      try {
        const attachment = await uploadAttachment(file);
        latest.current = [...latest.current, attachment];
        onFiles(latest.current);
      } catch (error) {
        onError(error instanceof ApiError ? error.message : `Couldn't upload ${file.name}.`);
      } finally {
        onUploading(-1);
      }
    }
  }
  return (
    <div>
      {label}
      <div className="mt-1.5 flex flex-col gap-1.5">
        {files.map((f) => (
          <div key={f.id} className="flex items-center gap-2 rounded-lg bg-subtle px-3 py-2 text-[13.5px] text-fg-2">
            <Paperclip size={14} className="shrink-0 text-fg-3" />
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            <button type="button" aria-label={`Remove ${f.name}`} onClick={() => onFiles(files.filter((x) => x.id !== f.id))} className={quiet}>
              <X size={13} />
            </button>
          </div>
        ))}
        {files.length < field.max ? (
          <button
            type="button"
            onClick={() => picker.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void add(e.dataTransfer.files);
            }}
            className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong px-3 py-3 text-[13.5px] text-fg-3 transition-colors hover:bg-hover hover:text-fg"
          >
            <FileUp size={15} />
            Drop a file or choose one ({field.accept.map((e) => e.toUpperCase()).join(", ")})
          </button>
        ) : null}
        <input
          ref={picker}
          type="file"
          hidden
          multiple={field.max > 1}
          accept={field.accept.map((e) => `.${e},${ATTACHMENT_TYPES[e] ?? ""}`).join(",")}
          onChange={(e) => {
            void add(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

function ListField({
  field,
  label,
  value,
  onChange,
}: {
  field: Extract<UiField, { kind: "list" }>;
  label: React.ReactNode;
  value: Record<string, string>[];
  onChange: (value: Record<string, string>[]) => void;
}) {
  const entries = value.length ? value : [{}];
  const put = (i: number, part: string, text: string) => onChange(entries.map((e, j) => (j === i ? { ...e, [part]: text } : e)));
  return (
    <div>
      {label}
      <div className="mt-1.5 flex flex-col gap-2">
        {entries.map((entry, i) => (
          <div key={i} className="rounded-lg border border-line px-3 pt-2 pb-3">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium text-fg-3">
                {field.itemLabel} {i + 1}
              </span>
              {entries.length > 1 ? (
                <button type="button" aria-label={`Remove ${field.itemLabel} ${i + 1}`} onClick={() => onChange(entries.filter((_, j) => j !== i))} className={quiet}>
                  <Trash2 size={13} />
                </button>
              ) : null}
            </div>
            <div className="mt-1 flex flex-col gap-2">
              {field.parts.map((part) => (
                <label key={part.id} className="block">
                  <span className="text-[12.5px] text-fg-3">{part.label}</span>
                  {part.long ? (
                    <textarea className={`${input} mt-1 min-h-16 resize-y`} value={entry[part.id] ?? ""} maxLength={2000} onChange={(e) => put(i, part.id, e.target.value)} />
                  ) : (
                    <input className={`${input} mt-1`} value={entry[part.id] ?? ""} maxLength={2000} onChange={(e) => put(i, part.id, e.target.value)} />
                  )}
                </label>
              ))}
            </div>
          </div>
        ))}
        {entries.length < field.max ? (
          <button type="button" onClick={() => onChange([...entries, {}])} className={`${quiet} self-start`}>
            <Plus size={13} />
            Add {field.itemLabel.toLowerCase()}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Apps to connect, each with its live status. Connecting opens the provider in a new tab. */
function ConnectField({ field, label }: { field: Extract<UiField, { kind: "connect" }>; label: React.ReactNode }) {
  const [state, setState] = useState<ConnectionsState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const load = () =>
      fetch("/api/workspace/connections")
        .then((r) => (r.ok ? (r.json() as Promise<ConnectionsState>) : null))
        .then(setState)
        .catch(() => setState(null));
    void load();
    // Coming back from the provider's tab picks up the new connection.
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, []);
  async function connect(slug: string) {
    setBusy(slug);
    const tab = window.open("", "_blank");
    const res = await fetch(`/api/workspace/connections/${slug}?return=/settings`, { method: "POST" });
    const body = (await res.json().catch(() => null)) as { url?: string } | null;
    if (body?.url && tab) tab.location.href = body.url;
    else tab?.close();
    setBusy(null);
  }
  return (
    <div>
      {label}
      {state && !state.configured ? (
        <p className="mt-1.5 text-[13px] text-fg-3">Connected apps aren&apos;t available yet.</p>
      ) : (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {field.apps.map((app) => {
            const slug = toolkitForApp(app) ?? app;
            const status = state?.toolkits.find((t) => t.slug === slug)?.status;
            return (
              <div key={app} className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2">
                <AppGlyph app={app} size={18} className="shrink-0" />
                <span className="min-w-0 flex-1 text-[13.5px] text-fg">{appName(app)}</span>
                {status === "connected" ? (
                  <span className="inline-flex items-center gap-1 text-[12.5px] text-success">
                    <Check size={13} /> Connected
                  </span>
                ) : (
                  <button type="button" disabled={!state || busy === slug} onClick={() => void connect(slug)} className={quiet}>
                    {busy === slug ? <span className="spinner size-3" aria-hidden="true" /> : <Plug size={13} />}
                    Connect
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface ProposalProps {
  proposal: AgentProposal;
  response?: UiResponse;
  canApply: boolean;
  onApply: (picks: ProposalPicks, edits: { profile?: string; instructions?: string }) => Promise<void>;
  onRunTask?: UiCardsProps["onRunTask"];
}

const every = (n: number) => Array.from({ length: n }, (_, i) => i);

/** The agent's suggested setup for itself. Nothing changes until the member applies it. */
export function ProposalCard({ proposal, response, canApply, onApply, onRunTask }: ProposalProps) {
  const [picks, setPicks] = useState<ProposalPicks>(() => ({
    profile: proposal.profile !== undefined,
    instructions: proposal.instructions !== undefined,
    skills: every(proposal.skills.length),
    tasks: every(proposal.tasks.length),
    memories: every(proposal.memories.length),
  }));
  const [profile, setProfile] = useState(proposal.profile ?? "");
  const [instructions, setInstructions] = useState(proposal.instructions ?? "");
  const [editing, setEditing] = useState<"profile" | "instructions" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const applied = response?.status === "applied" ? response : null;
  const live = canApply && !applied;
  // Once applied, what the server reports took effect; until then, the member's picks.
  const shown = applied ? applied.picks : picks;

  const toggle = (key: "skills" | "tasks" | "memories", i: number) =>
    setPicks((p) => ({ ...p, [key]: p[key].includes(i) ? p[key].filter((x) => x !== i) : [...p[key], i] }));
  const nothing = !picks.profile && !picks.instructions && !picks.skills.length && !picks.tasks.length && !picks.memories.length;

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      await onApply(picks, {
        ...(picks.profile ? { profile } : {}),
        ...(picks.instructions ? { instructions } : {}),
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't apply this. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const chosen = (on: boolean) => (applied ? on : true);
  const check = (on: boolean, onClick: () => void, name: string) =>
    live ? (
      <button
        type="button"
        role="checkbox"
        aria-checked={on}
        aria-label={name}
        onClick={onClick}
        className={`mt-[3px] flex size-[18px] shrink-0 items-center justify-center rounded-[5px] ${on ? "bg-accent text-on-inverse" : "border border-line-strong"}`}
      >
        {on ? <Check size={12} strokeWidth={2.5} /> : null}
      </button>
    ) : (
      <Check size={14} className={`mt-[3px] shrink-0 ${applied && on ? "text-success" : "text-fg-4"}`} />
    );

  const textItem = (key: "profile" | "instructions", title: string, value: string, set: (v: string) => void) =>
    proposal[key] !== undefined && chosen(shown[key]) ? (
      <div className="flex items-start gap-2.5">
        {check(shown[key], () => setPicks((p) => ({ ...p, [key]: !p[key] })), title)}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-medium text-fg">{title}</span>
            {live ? (
              <button type="button" onClick={() => setEditing(editing === key ? null : key)} className={quiet}>
                {editing === key ? "Done" : "Edit"}
              </button>
            ) : null}
          </div>
          {editing === key ? (
            <textarea className={`${input} mt-1 min-h-28 resize-y`} value={value} maxLength={8000} onChange={(e) => set(e.target.value)} />
          ) : (
            <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap text-[13px] leading-[1.5] text-fg-3 [overflow-wrap:anywhere]">{value}</p>
          )}
        </div>
      </div>
    ) : null;

  return (
    <section aria-label="Suggested setup" className={applied ? "mt-4 overflow-hidden rounded-xl border border-line animate-fade-up" : card}>
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <Sparkles size={17} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium tracking-[0.01em] text-fg-3">{applied ? "Applied setup" : "Suggested setup"}</p>
          {proposal.summary ? <p className="mt-0.5 text-[14.5px] leading-[1.5] text-fg [overflow-wrap:anywhere]">{proposal.summary}</p> : null}
        </div>
      </div>
      <div className="flex flex-col gap-3 px-4 pt-3 pb-4">
        {textItem("profile", "What this agent is for", profile, setProfile)}
        {textItem("instructions", "Standing instructions", instructions, setInstructions)}
        {proposal.tasks.map((t, i) =>
          chosen(shown.tasks.includes(i)) ? (
            <div key={`t${i}`} className="flex items-start gap-2.5">
              {check(shown.tasks.includes(i), () => toggle("tasks", i), t.title)}
              <div className="min-w-0 flex-1">
                <span className="text-[13px] font-medium text-fg">{t.title}</span>
                <span className="text-[12.5px] text-fg-3"> · {t.schedule ? describeSchedule(t.schedule, zone) : "When you ask"}</span>
                {t.instructions ? <p className="mt-0.5 line-clamp-2 text-[13px] leading-[1.5] text-fg-3">{t.instructions}</p> : null}
              </div>
            </div>
          ) : null,
        )}
        {proposal.skills.map((s, i) =>
          chosen(shown.skills.includes(i)) ? (
            <div key={`s${i}`} className="flex items-start gap-2.5">
              {check(shown.skills.includes(i), () => toggle("skills", i), "catalogId" in s ? s.catalogId : s.name)}
              <span className="min-w-0 flex-1 text-[13px] text-fg">
                <span className="font-medium">Skill:</span> {"catalogId" in s ? (catalogEntry(s.catalogId)?.name ?? s.catalogId) : s.name}
                {"catalogId" in s ? null : s.description ? <span className="text-fg-3"> · {s.description}</span> : null}
              </span>
            </div>
          ) : null,
        )}
        {proposal.memories.map((m, i) =>
          chosen(shown.memories.includes(i)) ? (
            <div key={`m${i}`} className="flex items-start gap-2.5">
              {check(shown.memories.includes(i), () => toggle("memories", i), m)}
              <span className="min-w-0 flex-1 text-[13px] text-fg-2">
                <span className="font-medium text-fg">Remember:</span> {m}
              </span>
            </div>
          ) : null,
        )}
      </div>
      {applied ? (
        <div className="border-t border-line">
          <p className="flex items-center gap-1.5 px-4 py-2 text-[12.5px] text-success">
            <Check size={13} className="settle-check" />
            {appliedText(applied.applied)}
          </p>
          {applied.taskIds?.length && onRunTask ? (
            <FirstRun taskId={applied.taskIds[0]} title={proposal.tasks[applied.picks.tasks[0]]?.title} onRun={onRunTask} />
          ) : null}
        </div>
      ) : live ? (
        <div className="flex items-center justify-end gap-2 border-t border-line px-3 py-2.5">
          <span className={`mr-auto pl-1 text-[12px] ${error ? "text-danger" : "text-fg-3"}`}>{error ?? "Nothing changes until you apply."}</span>
          <button type="button" onClick={() => void apply()} disabled={busy || nothing} className={primary}>
            {busy ? <span className="spinner size-3.5" aria-hidden="true" /> : <Check size={14} />}
            Apply
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** The first win: the agent does its first task now, while the member is still here to see it. */
function FirstRun({ taskId, title, onRun }: { taskId: string; title?: string; onRun: (taskId: string) => Promise<void> }) {
  const [state, setState] = useState<"idle" | "starting" | "started">("idle");
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setState("starting");
    setError(null);
    try {
      await onRun(taskId);
      setState("started");
    } catch (e) {
      setState("idle");
      setError(e instanceof ApiError ? e.message : "Couldn't start it. Try again.");
    }
  }
  return (
    <div className="flex items-center justify-end gap-2 border-t border-line px-3 py-2.5 animate-fade-in">
      <span className={`mr-auto min-w-0 truncate pl-1 text-[12.5px] ${error ? "text-danger" : "text-fg-3"}`}>
        {error ?? (state === "started" ? "Started. It's running in its own chat." : title ? `First up: ${title}` : "See it work on the real thing.")}
      </span>
      <button type="button" onClick={() => void run()} disabled={state !== "idle"} className={primary}>
        {state === "starting" ? <span className="spinner size-3.5" aria-hidden="true" /> : state === "started" ? <Check size={14} /> : <Sparkles size={14} />}
        {state === "started" ? "Started" : "Do the first one now"}
      </button>
    </div>
  );
}

function appliedText(a: Extract<UiResponse, { status: "applied" }>["applied"]): string {
  const parts = [
    a.settings ? "updated what it's for and how it works" : "",
    a.tasks ? `${a.tasks} task${a.tasks === 1 ? "" : "s"} on` : "",
    a.skills ? `${a.skills} skill${a.skills === 1 ? "" : "s"} added` : "",
    a.memories ? `${a.memories} fact${a.memories === 1 ? "" : "s"} remembered` : "",
  ].filter(Boolean);
  const skipped = a.skipped ? ` ${a.skipped} item${a.skipped === 1 ? "" : "s"} couldn't be applied on your account.` : "";
  return (parts.length ? `Applied: ${parts.join(", ")}.` : "Applied. Nothing needed changing.") + skipped;
}

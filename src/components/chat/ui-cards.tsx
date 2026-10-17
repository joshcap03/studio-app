"use client";

import { ArrowUp, Check, ClipboardList, FileUp, Paperclip, Plug, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { appName, toolkitForApp } from "@/lib/apps";
import { formAnswerText, missingAnswer, type FormValues } from "@/lib/chat/ui-answer";
import { api, ApiError, uploadAttachment } from "@/lib/client/api";
import { catalogEntry } from "@/lib/skills/catalog";
import { describeSchedule } from "@/lib/tasks/schedule";
import type { AgentProposal, Attachment, ConnectionsState, ProposalPicks, UiBlock, UiField, UiForm, UiResponse } from "@/lib/types";
import { ATTACHMENT_TYPES } from "@/lib/types";
import { AppGlyph } from "./app-glyph";

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
}

export function UiCards({ blocks, responses, conversationId, messageId, onAnswer, onResponse, settled }: UiCardsProps) {
  return (
    <>
      {blocks.map((block) =>
        block.kind === "form" ? (
          <FormCard
            key={block.id}
            form={block}
            response={responses?.[block.id]}
            onAnswer={onAnswer}
            onSubmit={async (keepFiles) => {
              const { response } = await api.answerUi(conversationId, block.id, { action: "submit", ...(keepFiles.length ? { keepFiles } : {}) });
              onResponse?.(messageId, block.id, response);
            }}
          />
        ) : (
          <ProposalCard
            key={block.id}
            proposal={block}
            response={responses?.[block.id]}
            canApply={settled && Boolean(onResponse)}
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

function initialValues(form: UiForm): FormValues {
  const values: FormValues = {};
  for (const f of form.fields) {
    if ((f.kind === "choice" || f.kind === "multi_choice") && f.prefill) values[f.id] = f.prefill;
    else if ((f.kind === "text" || f.kind === "long_text") && f.prefill) values[f.id] = f.prefill;
    else if (f.kind === "list") values[f.id] = f.prefill?.length ? f.prefill : [{}];
  }
  return values;
}

interface FormProps {
  form: UiForm;
  response?: UiResponse;
  onAnswer?: UiCardsProps["onAnswer"];
  /** Marks the form answered, first moving the uploads in `keepFiles` onto the agent's shelf. */
  onSubmit: (keepFiles: string[]) => Promise<void>;
}

/** A form the agent asked the member to fill in. Its answers go out as their next message. */
export function FormCard({ form, response, onAnswer, onSubmit }: FormProps) {
  const [values, setValues] = useState<FormValues>(() => initialValues(form));
  const [files, setFiles] = useState<Record<string, Attachment[]>>({});
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!onAnswer || sent || response) {
    const answered = sent || response?.status === "submitted";
    return (
      <section aria-label="Form from the agent" className="mt-3 flex items-start gap-2 text-[13px] leading-[1.5] text-fg-3 animate-fade-up">
        {answered ? <Check size={14} className="mt-[3px] shrink-0 text-success" /> : <ClipboardList size={14} className="mt-[3px] shrink-0 text-fg-4" />}
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {form.title}
          {answered ? <span className="text-fg-4"> · Sent</span> : null}
        </span>
      </section>
    );
  }

  const set = (id: string, value: FormValues[string]) => setValues((v) => ({ ...v, [id]: value }));

  async function submit() {
    if (!onAnswer || sent || busy || uploading > 0) return;
    const withFiles: FormValues = { ...values };
    for (const [id, list] of Object.entries(files)) if (list.length) withFiles[id] = list.map((a) => a.name);
    const missing = missingAnswer(form, withFiles);
    if (missing) {
      setError(`Fill in “${missing}” first.`);
      return;
    }
    // Files from "keep" fields move onto the agent's shelf, which sends them with every run
    // (this one included); the rest ride along on the answer like any attachment.
    const kept = new Set(form.fields.filter((f) => f.kind === "file" && f.keep).map((f) => f.id));
    const keepFiles = Object.entries(files).flatMap(([id, list]) => (kept.has(id) ? list.map((a) => a.id) : []));
    const attachments = Object.entries(files).flatMap(([id, list]) => (kept.has(id) ? [] : list));
    setBusy(true);
    try {
      await onSubmit(keepFiles);
    } catch (e) {
      setBusy(false);
      setError(e instanceof ApiError ? e.message : "Couldn't send this. Try again.");
      return;
    }
    setSent(true);
    onAnswer(formAnswerText(form, withFiles), { attachments });
  }

  return (
    <section aria-label="Form from the agent" className={card}>
      <div className="px-4 pt-3.5">
        <p className="text-[12px] font-medium tracking-[0.01em] text-fg-3">{form.title}</p>
        {form.intro ? <p className="mt-0.5 text-[14px] leading-[1.5] text-fg-2 [overflow-wrap:anywhere]">{form.intro}</p> : null}
      </div>
      <div className="flex flex-col gap-4 px-4 pt-3 pb-4">
        {form.fields.map((field) => (
          <FieldView
            key={field.id}
            field={field}
            value={values[field.id]}
            files={files[field.id] ?? []}
            onChange={(v) => {
              setError(null);
              set(field.id, v);
            }}
            onFiles={(list) => setFiles((all) => ({ ...all, [field.id]: list }))}
            onUploading={(delta) => setUploading((n) => n + delta)}
            onError={setError}
          />
        ))}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line px-3 py-2.5">
        <span className={`mr-auto pl-1 text-[12px] ${error ? "text-danger" : "text-fg-3"}`}>{error ?? "Or type your own answer below."}</span>
        <button type="button" onClick={() => void submit()} disabled={uploading > 0 || busy} className={primary}>
          {uploading > 0 || busy ? <span className="spinner size-3.5" aria-hidden="true" /> : <ArrowUp size={14} />}
          {form.submitLabel}
        </button>
      </div>
    </section>
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
      {field.required ? null : field.kind === "connect" ? null : <span className="text-[12px] text-fg-4"> · Optional</span>}
      {field.help ? <span className="mt-0.5 block text-[12.5px] leading-[1.45] text-fg-3">{field.help}</span> : null}
    </span>
  );
  switch (field.kind) {
    case "choice":
    case "multi_choice": {
      const picked = Array.isArray(value) ? (value as string[]) : [];
      const multi = field.kind === "multi_choice";
      return (
        <fieldset>
          <legend className="contents">{label}</legend>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {field.options.map((o) => {
              const chosen = picked.includes(o.label);
              return (
                <button
                  key={o.label}
                  type="button"
                  role={multi ? "checkbox" : "radio"}
                  aria-checked={chosen}
                  title={o.description}
                  onClick={() => onChange(multi ? (chosen ? picked.filter((l) => l !== o.label) : [...picked, o.label]) : chosen ? [] : [o.label])}
                  className={`inline-flex min-h-8 items-center gap-1.5 rounded-lg border px-3 py-1 text-[13.5px] transition-colors ${
                    chosen ? "border-accent bg-accent-soft text-fg" : "border-line text-fg-2 hover:border-line-strong hover:bg-hover"
                  }`}
                >
                  {chosen ? <Check size={13} strokeWidth={2.5} className="text-accent" /> : null}
                  {o.label}
                </button>
              );
            })}
          </div>
        </fieldset>
      );
    }
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
}

const every = (n: number) => Array.from({ length: n }, (_, i) => i);

/** The agent's suggested setup for itself. Nothing changes until the member applies it. */
export function ProposalCard({ proposal, response, canApply, onApply }: ProposalProps) {
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
        <p className="flex items-center gap-1.5 border-t border-line px-4 py-2 text-[12.5px] text-success">
          <Check size={13} />
          {appliedText(applied.applied)}
        </p>
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

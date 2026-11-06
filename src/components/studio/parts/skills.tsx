"use client";

import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";
import { ApiError, api } from "@/lib/client/api";
import { ASKS, skillOrigin } from "@/lib/studio";
import { MAX_SKILL_DESCRIPTION_LENGTH, MAX_SKILL_INSTRUCTIONS_LENGTH, MAX_SKILL_NAME_LENGTH, type MessageSkill, type WorkspaceSkill } from "@/lib/types";
import { DescribeBar, primaryAsk, quietLink, secondaryAsk } from "../ask-link";
import { saveLine, useAutosave } from "../use-autosave";
import { fieldClass, PartHead, Unread } from "./shared";

// The jobs the agent knows how to do. Each row opens into its words, saved as they're typed. "Try
// it" attaches it to the Try pane's message, the way "/" does.

type Fields = { name: string; description: string; instructions: string };

const message = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");

export function SkillsPart({
  skills,
  teach,
  owner,
  saveNow,
  onDescribe,
  onChange,
}: {
  skills: WorkspaceSkill[] | null;
  /** "Show me once", where there's a hosted browser. */
  teach: WorkspaceSkill | null;
  owner: boolean;
  saveNow: RefObject<(() => void) | null>;
  onDescribe: (text: string | null, skill?: MessageSkill | null) => void;
  onChange: (skills: WorkspaceSkill[]) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  if (skills === null) return <Unread>The skills couldn&apos;t be read just now.</Unread>;

  async function remove(skill: WorkspaceSkill) {
    setNotice(null);
    try {
      await api.deleteSkill(skill.id);
      onChange((skills ?? []).filter((s) => s.id !== skill.id));
      setOpen(null);
      setNotice(`Removed ${skill.name}. History can bring it back.`);
    } catch (e) {
      setNotice(message(e));
    }
  }

  return (
    <>
      <PartHead title="Skills" hint="Jobs it knows how to do. Use one with / in any message.">
        {owner ? (
          <>
            {teach ? (
              <button type="button" onClick={() => onDescribe(ASKS.teach, { id: teach.id, name: teach.name })} className={secondaryAsk}>
                Show me once
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setAdding(true);
                setOpen(null);
              }}
              className={secondaryAsk}
            >
              <Plus size={14} aria-hidden="true" />
              New skill
            </button>
          </>
        ) : null}
      </PartHead>
      {notice ? (
        <p role="status" className="mb-3 text-[13px] text-fg-3">
          {notice}
        </p>
      ) : null}
      {adding ? (
        <NewSkill
          onCancel={() => setAdding(false)}
          onCreated={(skill) => {
            onChange([...skills, skill]);
            setAdding(false);
            setOpen(skill.id);
          }}
        />
      ) : null}
      {skills.length === 0 && !adding ? (
        <Unread>Only the basics so far. Teach it a job once and it&apos;ll remember how.</Unread>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {skills.map((s) => (
            <li key={s.id}>
              <button type="button" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)} className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-hover">
                <ChevronRight size={14} className={`shrink-0 text-fg-4 transition-transform ${open === s.id ? "rotate-90" : ""}`} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg">
                  <span className="font-mono text-fg-4" aria-hidden="true">
                    /{" "}
                  </span>
                  {s.name}
                </span>
                <span className="shrink-0 text-[12px] text-fg-4">{skillOrigin(s)}</span>
              </button>
              {open === s.id ? (
                <SkillEditor
                  key={s.id}
                  skill={s}
                  owner={owner}
                  saveNow={saveNow}
                  onUse={() => onDescribe(null, { id: s.id, name: s.name })}
                  onRemove={() => void remove(s)}
                  onSaved={(saved) => onChange(skills.map((x) => (x.id === saved.id ? saved : x)))}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 space-y-3">
        {owner ? <DescribeBar lead={ASKS.skill} placeholder="Or describe a job, and it drafts the skill" onDescribe={onDescribe} /> : null}
        <a href="/skills" className={quietLink}>
          Browse the library
        </a>
      </div>
    </>
  );
}

function Inputs({ value, onChange, onBlur, autoFocus = false }: { value: Fields; onChange: (next: Fields) => void; onBlur?: () => void; autoFocus?: boolean }) {
  return (
    <div className="space-y-2.5">
      <label className="block">
        <span className="text-[12.5px] font-medium text-fg-2">Name</span>
        <input autoFocus={autoFocus} required maxLength={MAX_SKILL_NAME_LENGTH} value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} onBlur={onBlur} className={`mt-1 h-9 text-[13.5px] ${fieldClass}`} />
      </label>
      <label className="block">
        <span className="text-[12.5px] font-medium text-fg-2">Description</span>
        <input
          maxLength={MAX_SKILL_DESCRIPTION_LENGTH}
          value={value.description}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
          onBlur={onBlur}
          placeholder="One line on what it does"
          className={`mt-1 h-9 text-[13.5px] ${fieldClass}`}
        />
      </label>
      <label className="block">
        <span className="text-[12.5px] font-medium text-fg-2">Steps</span>
        <textarea
          required
          rows={7}
          maxLength={MAX_SKILL_INSTRUCTIONS_LENGTH}
          value={value.instructions}
          onChange={(e) => onChange({ ...value, instructions: e.target.value })}
          onBlur={onBlur}
          placeholder={"1. Pull last week's orders.\n2. …"}
          className={`mt-1 max-h-[50vh] resize-none py-2 font-mono text-[12.5px] leading-relaxed [field-sizing:content] ${fieldClass}`}
        />
      </label>
    </div>
  );
}

function SkillEditor({
  skill,
  owner,
  saveNow,
  onUse,
  onRemove,
  onSaved,
}: {
  skill: WorkspaceSkill;
  owner: boolean;
  saveNow: RefObject<(() => void) | null>;
  onUse: () => void;
  onRemove: () => void;
  onSaved: (skill: WorkspaceSkill) => void;
}) {
  const [fields, setFields] = useState<Fields>({ name: skill.name, description: skill.description, instructions: skill.instructions });
  const { status, error, flush } = useAutosave(
    fields,
    async (next) => {
      onSaved((await api.updateSkill(skill.id, next)).skill);
    },
    { valid: owner && Boolean(fields.name.trim() && fields.instructions.trim()) },
  );
  useEffect(() => {
    saveNow.current = flush;
    return () => {
      saveNow.current = null;
    };
  }, [flush, saveNow]);

  return (
    <div className="border-t border-line px-3.5 py-3 animate-fade-in">
      {owner ? (
        <Inputs value={fields} onChange={setFields} onBlur={flush} />
      ) : (
        <>
          {skill.description ? <p className="mb-2 text-[13px] text-fg-3">{skill.description}</p> : null}
          <p className="whitespace-pre-wrap font-mono text-[12.5px] leading-relaxed text-fg-2 [overflow-wrap:anywhere]">{skill.instructions}</p>
        </>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <button type="button" onClick={onUse} className={secondaryAsk}>
          Try it
        </button>
        <span role="status" className={`min-w-0 flex-1 text-[12px] ${status === "error" ? "text-danger" : "text-fg-3"}`}>
          {saveLine(status, error)}
        </span>
        {owner ? (
          <button type="button" aria-label={`Remove ${skill.name}`} title="Remove" onClick={onRemove} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-hover hover:text-danger">
            <Trash2 size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function NewSkill({ onCancel, onCreated }: { onCancel: () => void; onCreated: (skill: WorkspaceSkill) => void }) {
  const [fields, setFields] = useState<Fields>({ name: "", description: "", instructions: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="mb-3 rounded-xl border border-line bg-surface px-3.5 py-3 animate-fade-up"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        api.createSkill(fields).then(
          ({ skill }) => onCreated(skill),
          (err: unknown) => {
            setError(message(err));
            setBusy(false);
          },
        );
      }}
    >
      <Inputs value={fields} onChange={setFields} autoFocus />
      <div className="mt-3 flex items-center justify-end gap-3">
        {error ? (
          <p role="alert" className="mr-auto text-[13px] text-danger">
            {error}
          </p>
        ) : null}
        <button type="button" onClick={onCancel} className={quietLink}>
          Cancel
        </button>
        <button type="submit" disabled={busy || !fields.name.trim() || !fields.instructions.trim()} className={`${primaryAsk} disabled:opacity-30`}>
          {busy ? "Adding…" : "Add skill"}
        </button>
      </div>
    </form>
  );
}

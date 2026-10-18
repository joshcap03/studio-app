"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { fillField, fillQuestions, type VoiceFill } from "@/lib/chat/ui-fill";
import { formAnswerText, missingAnswer, type FormValues } from "@/lib/chat/ui-answer";
import { api, ApiError } from "@/lib/client/api";
import type { Attachment, Question, UiForm, UiResponse, Verdict } from "@/lib/types";

// What the member has filled in on the agent's cards, before they send it, owned by the
// workspace rather than each card. On a call the same card shows in the thread and on the call's
// stage, and the member can answer it by tapping or by voice: one draft per card keeps all of
// that in step. Sending goes through the card's one submit path either way.

export interface FormDraft {
  values: FormValues;
  files: Record<string, Attachment[]>;
  /** Answers heard on a call that need the member's tap first ("Heard: …?"), by field. */
  heard: Record<string, { value: FormValues[string]; said: string }>;
  uploading: number;
  error: string | null;
  busy: boolean;
  sent: boolean;
}

export interface QuestionDraft {
  picks: string[][];
  heard: { picks: string[][]; said: string } | null;
  sent: boolean;
}

/** Where a form's answer goes: the reply it's under, and what to do once the server saved it. */
export interface FormBinding {
  form: UiForm;
  conversationId: string;
  messageId: string;
  onAnswer: (text: string, extras: { attachments: Attachment[] }) => void;
  onResponse?: (messageId: string, blockId: string, response: UiResponse) => void;
}

/** What a voice fill did; `said` names the field (for the voice), the card shows the answer alone. */
export type FillResult = { status: "filled" | "heard"; said: string } | { status: "refused"; reason: string };

interface CardDraftsValue {
  form(form: UiForm): FormDraft;
  updateForm(form: UiForm, fn: (draft: FormDraft) => FormDraft): void;
  /** Sends the form the same way its Send button does; resolves to an error to show, or null. */
  submitForm(binding: FormBinding): Promise<string | null>;
  /** Fills one field from what the member said on a call (checked by ui-fill). */
  fillForm(form: UiForm, fill: VoiceFill, words: string): FillResult;
  question(key: string, questions: Question[]): QuestionDraft;
  updateQuestion(key: string, questions: Question[], fn: (draft: QuestionDraft) => QuestionDraft): void;
  fillQuestion(key: string, questions: Question[], answers: unknown): FillResult;
  /** Sends the picked answers as the member's next message; an error to show, or null. */
  submitQuestions(key: string, questions: Question[], onAnswer: (text: string) => void): string | null;
}

const Context = createContext<CardDraftsValue | null>(null);

export function initialFormValues(form: UiForm): FormValues {
  const values: FormValues = {};
  for (const f of form.fields) {
    if ((f.kind === "choice" || f.kind === "multi_choice") && f.prefill) values[f.id] = f.prefill;
    else if ((f.kind === "text" || f.kind === "long_text") && f.prefill) values[f.id] = f.prefill;
    else if (f.kind === "list") values[f.id] = f.prefill?.length ? f.prefill : [{}];
    else if (f.kind === "rank") values[f.id] = f.prefill ?? f.options.map((o) => o.label);
    else if (f.kind === "scale" && f.prefill) values[f.id] = String(f.prefill);
  }
  return values;
}

const freshForm = (form: UiForm): FormDraft => ({ values: initialFormValues(form), files: {}, heard: {}, uploading: 0, error: null, busy: false, sent: false });
const freshQuestion = (questions: Question[]): QuestionDraft => ({ picks: questions.map(() => []), heard: null, sent: false });

/** The message that answers `questions` with the member's picks. */
export function answerText(questions: Question[], picks: string[][]): string {
  if (questions.length === 1) return picks[0].join(", ");
  return questions.map((q, i) => `${q.header ? `${q.header}:` : q.question} ${picks[i].join(", ")}`).join("\n");
}

export function CardDraftsProvider({ children }: { children: React.ReactNode }) {
  // Read and written synchronously (a voice fill and its "send" can come back to back), and
  // re-rendered from by version.
  const drafts = useRef(new Map<string, FormDraft | QuestionDraft>());
  const [version, setVersion] = useState(0);
  const put = useCallback((key: string, draft: FormDraft | QuestionDraft) => {
    drafts.current.set(key, draft);
    setVersion((v) => v + 1);
  }, []);

  const form = useCallback((f: UiForm) => (drafts.current.get(f.id) as FormDraft | undefined) ?? freshForm(f), []);
  const updateForm = useCallback((f: UiForm, fn: (d: FormDraft) => FormDraft) => put(f.id, fn(form(f))), [form, put]);

  const submitForm = useCallback(
    async ({ form: f, conversationId, messageId, onAnswer, onResponse }: FormBinding): Promise<string | null> => {
      const draft = form(f);
      if (draft.sent) return null;
      if (draft.busy || draft.uploading > 0) return "It's still sending or uploading.";
      const withFiles: FormValues = { ...draft.values };
      for (const [id, list] of Object.entries(draft.files)) if (list.length) withFiles[id] = list.map((a) => a.name);
      const missing = missingAnswer(f, withFiles);
      if (missing) {
        const error = `Fill in “${missing}” first.`;
        updateForm(f, (d) => ({ ...d, error }));
        return error;
      }
      // Files from "keep" fields move onto the agent's shelf, which sends them with every run
      // (this one included); the rest ride along on the answer like any attachment.
      const kept = new Set(f.fields.filter((x) => x.kind === "file" && x.keep).map((x) => x.id));
      const keepFiles = Object.entries(draft.files).flatMap(([id, list]) => (kept.has(id) ? list.map((a) => a.id) : []));
      const attachments = Object.entries(draft.files).flatMap(([id, list]) => (kept.has(id) ? [] : list));
      const verdicts = f.fields.flatMap((x) =>
        x.kind === "verdict" && Array.isArray(draft.values[x.id])
          ? (draft.values[x.id] as Record<string, string>[])
              .filter((c) => c.verdict === "keep" || c.verdict === "pass")
              .map((c) => ({ fieldId: x.id, itemId: c.id, verdict: c.verdict as Verdict, ...(c.verdict === "pass" && c.reason?.trim() ? { reason: c.reason.trim() } : {}) }))
          : [],
      );
      updateForm(f, (d) => ({ ...d, busy: true, error: null }));
      try {
        const { response } = await api.answerUi(conversationId, f.id, {
          action: "submit",
          ...(keepFiles.length ? { keepFiles } : {}),
          ...(verdicts.length ? { verdicts } : {}),
        });
        onResponse?.(messageId, f.id, response);
      } catch (e) {
        const error = e instanceof ApiError ? e.message : "Couldn't send this. Try again.";
        updateForm(f, (d) => ({ ...d, busy: false, error }));
        return error;
      }
      updateForm(f, (d) => ({ ...d, busy: false, sent: true }));
      onAnswer(formAnswerText(f, withFiles), { attachments });
      return null;
    },
    [form, updateForm],
  );

  const fillForm = useCallback(
    (f: UiForm, fill: VoiceFill, words: string): FillResult => {
      const draft = form(f);
      if (draft.sent || draft.busy) return { status: "refused", reason: "That card was already sent." };
      const out = fillField(f, draft.values, fill, words);
      if (!out.ok) return { status: "refused", reason: out.reason };
      if (out.heard) {
        updateForm(f, (d) => ({ ...d, heard: { ...d.heard, [out.fieldId]: { value: out.value, said: out.shown } } }));
        return { status: "heard", said: out.said };
      }
      updateForm(f, (d) => {
        const { [out.fieldId]: _, ...heard } = d.heard;
        return { ...d, error: null, values: { ...d.values, [out.fieldId]: out.value }, heard };
      });
      return { status: "filled", said: out.said };
    },
    [form, updateForm],
  );

  const question = useCallback((key: string, q: Question[]) => (drafts.current.get(key) as QuestionDraft | undefined) ?? freshQuestion(q), []);
  const updateQuestion = useCallback((key: string, q: Question[], fn: (d: QuestionDraft) => QuestionDraft) => put(key, fn(question(key, q))), [put, question]);

  const fillQuestion = useCallback(
    (key: string, q: Question[], answers: unknown): FillResult => {
      const draft = question(key, q);
      if (draft.sent) return { status: "refused", reason: "Those questions were already answered." };
      const out = fillQuestions(q, draft.picks, answers);
      if (!out.ok) return { status: "refused", reason: out.reason };
      if (out.heard) {
        updateQuestion(key, q, (d) => ({ ...d, heard: { picks: out.picks, said: out.said } }));
        return { status: "heard", said: out.said };
      }
      updateQuestion(key, q, (d) => ({ ...d, picks: out.picks, heard: null }));
      return { status: "filled", said: out.said };
    },
    [question, updateQuestion],
  );

  const submitQuestions = useCallback(
    (key: string, q: Question[], onAnswer: (text: string) => void): string | null => {
      const draft = question(key, q);
      if (draft.sent) return null;
      if (!draft.picks.every((p) => p.length > 0)) return "Pick an answer for each question first.";
      updateQuestion(key, q, (d) => ({ ...d, sent: true }));
      onAnswer(answerText(q, draft.picks));
      return null;
    },
    [question, updateQuestion],
  );

  const value = useMemo<CardDraftsValue>(
    () => ({ form, updateForm, submitForm, fillForm, question, updateQuestion, fillQuestion, submitQuestions }),
    // `version` makes every reader re-render when any draft changes.
    [version, form, updateForm, submitForm, fillForm, question, updateQuestion, fillQuestion, submitQuestions],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The workspace's card drafts. */
export function useCardDrafts(): CardDraftsValue {
  const value = useContext(Context);
  if (!value) throw new Error("Card drafts need a CardDraftsProvider.");
  return value;
}

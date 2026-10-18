import { spokenWords } from "@/lib/voice/intent";
import type { FormValues } from "./ui-answer";
import type { UiField, UiForm } from "@/lib/types";

// Filling a form card from what the member said on a call. The voice front proposes a value for
// one field (fill_card); this checks it against the field before anything changes, the way the
// card itself would only let them pick what's there. A value that only loosely matches, or words
// the member didn't actually say, comes back as `heard`: shown as "Heard: …?" for them to confirm
// with a tap, never applied on its own. Files, apps to connect, and anything else that's a tap stay
// taps. Nothing here sends: sending is the card's own submit. Pure.

/** One field's answer as the voice front proposed it. */
export interface VoiceFill {
  /** The field's id (or, failing that, its label). */
  field: string;
  value: unknown;
  /** False when the voice front was guessing. */
  sure?: boolean;
}

export type FillOutcome =
  | {
      ok: true;
      fieldId: string;
      /** The field's whole new value (merged with what was there for verdicts and lists). */
      value: FormValues[string];
      /** Only loosely matched or not quite what they said: confirm before using it. */
      heard: boolean;
      /** What it says now, in a few words, e.g. "Where: Remote, Hybrid". */
      said: string;
      /** The same without the field's label, for showing under the field: "Remote, Hybrid". */
      shown: string;
    }
  | { ok: false; reason: string };

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
};

const norm = (s: string) => spokenWords(s);

/** A whole number from 7, "7", "seven", or "the third". */
export function spokenNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value !== "string") return null;
  const words = norm(value).replace(/^(the|a|an|number|item|option)\s+/, "").replace(/\s+(one|out of \d+|of \d+)$/, "");
  if (/^\d+$/.test(words)) return Number(words);
  return NUMBER_WORDS[words] ?? null;
}

/** Whether `text` is what the member said: its words appear, in order, in their own words. */
export function heardIn(text: string, words: string): boolean {
  const said = norm(text);
  return said.length > 0 && ` ${norm(words)} `.includes(` ${said} `);
}

function findField(form: UiForm, ref: string): UiField | "ambiguous" | null {
  const byId = form.fields.find((f) => f.id === ref);
  if (byId) return byId;
  const want = norm(ref);
  if (!want) return null;
  const exact = form.fields.filter((f) => norm(f.label) === want);
  if (exact.length === 1) return exact[0];
  const loose = form.fields.filter((f) => norm(f.label).includes(want) || want.includes(norm(f.label)));
  if (loose.length === 1) return loose[0];
  return loose.length > 1 || exact.length > 1 ? "ambiguous" : null;
}

/** An option by label: exact (sure), or the one option that loosely matches (heard). */
function matchOption(options: string[], value: string): { label: string; loose: boolean } | null {
  const want = norm(value);
  if (!want) return null;
  const exact = options.find((o) => norm(o) === want);
  if (exact) return { label: exact, loose: false };
  const loose = options.filter((o) => norm(o).includes(want) || want.includes(norm(o)));
  return loose.length === 1 ? { label: loose[0], loose: true } : null;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value];
}

const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * Checks one proposed answer against its field and returns the field's new value. `current` is
 * what's filled in now; `words` is what the member said lately (verbatim), which text answers
 * and "own words" must come from.
 */
export function fillField(form: UiForm, current: FormValues, fill: VoiceFill, words: string): FillOutcome {
  const field = findField(form, String(fill.field ?? ""));
  if (field === "ambiguous") return { ok: false, reason: `More than one field matches “${clip(String(fill.field))}”. Use the field's id.` };
  if (!field) return { ok: false, reason: `There's no “${clip(String(fill.field))}” on this card.` };
  const unsure = fill.sure === false;
  const done = (value: FormValues[string], loose: boolean, said: string): FillOutcome => ({
    ok: true,
    fieldId: field.id,
    value,
    heard: unsure || loose,
    said: `${field.label}: ${clip(said)}`,
    shown: clip(said),
  });

  switch (field.kind) {
    case "file":
    case "connect":
      return { ok: false, reason: `“${field.label}” is a tap: ${field.kind === "file" ? "they add the file on screen" : "they connect the app on screen"}.` };

    case "choice":
    case "multi_choice": {
      const labels = field.options.map((o) => o.label);
      const picked: string[] = [];
      let loose = false;
      for (const raw of asList(fill.value)) {
        if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: `Give “${field.label}” an option's name.` };
        const match = matchOption(labels, raw);
        if (match) {
          picked.push(match.label);
          loose ||= match.loose;
        } else if (field.allowOther) {
          // Their own answer: it has to be what they said.
          const own = raw.trim().slice(0, 200);
          picked.push(own);
          loose ||= !heardIn(own, words);
        } else {
          return { ok: false, reason: `“${clip(raw)}” isn't one of the options for “${field.label}”: ${labels.join(", ")}.` };
        }
      }
      const unique = [...new Set(picked)];
      if (unique.length === 0) return { ok: false, reason: `Nothing to pick for “${field.label}”.` };
      if (field.kind === "choice" && unique.length > 1) return { ok: false, reason: `“${field.label}” takes one answer.` };
      return done(unique, loose, unique.join(", "));
    }

    case "rank": {
      const labels = field.options.map((o) => o.label);
      const order = Array.isArray(current[field.id]) ? (current[field.id] as string[]).filter((l) => labels.includes(l)) : field.prefill ?? labels;
      const named: string[] = [];
      let loose = false;
      for (const raw of asList(fill.value)) {
        const match = typeof raw === "string" ? matchOption(labels, raw) : null;
        if (!match) return { ok: false, reason: `“${clip(String(raw))}” isn't one of the things to rank: ${labels.join(", ")}.` };
        if (!named.includes(match.label)) named.push(match.label);
        loose ||= match.loose;
      }
      if (named.length === 0) return { ok: false, reason: `Say what goes first in “${field.label}”.` };
      // The ones they named go first, in their order; the rest keep their places after them.
      const next = [...named, ...[...order, ...labels.filter((l) => !order.includes(l))].filter((l) => !named.includes(l))];
      return done(next, loose, next.map((l, i) => `${i + 1}. ${l}`).join(", "));
    }

    case "scale": {
      const n = spokenNumber(fill.value);
      if (n === null || n < 1 || n > field.steps) return { ok: false, reason: `“${field.label}” takes a number from 1 to ${field.steps}.` };
      return done(String(n), false, `${n} of ${field.steps}`);
    }

    case "verdict": {
      const calls = Array.isArray(current[field.id]) ? [...(current[field.id] as Record<string, string>[])] : [];
      let loose = false;
      const changed: string[] = [];
      for (const raw of asList(fill.value)) {
        if (!raw || typeof raw !== "object") return { ok: false, reason: `Give each call on “${field.label}” as {item, verdict}.` };
        const { item, verdict, reason } = raw as { item?: unknown; verdict?: unknown; reason?: unknown };
        if (verdict !== "keep" && verdict !== "pass") return { ok: false, reason: "A verdict is keep or pass." };
        let target = field.items.find((i) => i.id === item);
        const n = target ? null : spokenNumber(item);
        if (!target && n !== null) target = field.items[n - 1];
        if (!target && typeof item === "string") {
          const match = matchOption(field.items.map((i) => i.title), item);
          if (match) {
            target = field.items.find((i) => i.title === match.label);
            loose ||= match.loose;
          }
        }
        if (!target) return { ok: false, reason: `There's no item “${clip(String(item))}” to judge; they're numbered 1 to ${field.items.length}.` };
        const call: Record<string, string> = { id: target.id, verdict };
        if (verdict === "pass" && typeof reason === "string" && reason.trim()) {
          const listed = matchOption(field.reasons, reason);
          if (listed && !listed.loose) call.reason = listed.label;
          else {
            call.reason = reason.trim().slice(0, 200);
            loose ||= !heardIn(call.reason, words);
          }
        }
        const at = calls.findIndex((c) => c.id === target!.id);
        if (at >= 0) calls[at] = call;
        else calls.push(call);
        const index = field.items.indexOf(target) + 1;
        changed.push(`${verdict === "keep" ? "Keep" : "Pass"} ${index}${call.reason ? ` (${call.reason})` : ""}`);
      }
      if (changed.length === 0) return { ok: false, reason: `Say keep or pass for something in “${field.label}”.` };
      return done(calls, loose, changed.join(", "));
    }

    case "text":
    case "long_text": {
      if (typeof fill.value !== "string" || !fill.value.trim()) return { ok: false, reason: `Give “${field.label}” the words they said.` };
      const text = fill.value.trim().slice(0, field.kind === "text" ? 500 : 4000);
      return done(text, !heardIn(text, words), text);
    }

    case "list": {
      const { entry, part, text } = (fill.value ?? {}) as { entry?: unknown; part?: unknown; text?: unknown };
      const entries = Array.isArray(current[field.id]) ? [...(current[field.id] as Record<string, string>[])] : field.prefill?.length ? [...field.prefill] : [{}];
      const n = spokenNumber(entry ?? 1);
      const piece = field.parts.find((p) => p.id === part) ?? (typeof part === "string" ? field.parts.find((p) => norm(p.label) === norm(part)) : undefined);
      if (!piece) return { ok: false, reason: `“${field.label}” has these parts: ${field.parts.map((p) => p.id).join(", ")}.` };
      if (n === null || n < 1 || n > Math.min(entries.length + 1, field.max)) return { ok: false, reason: `There's no ${field.itemLabel.toLowerCase()} ${String(entry)}.` };
      if (typeof text !== "string" || !text.trim()) return { ok: false, reason: "Give the words they said." };
      const words2000 = text.trim().slice(0, 2000);
      const next = entries.map((e) => ({ ...e }));
      if (n > next.length) next.push({});
      next[n - 1] = { ...next[n - 1], [piece.id]: words2000 };
      return done(next, !heardIn(words2000, words), `${field.itemLabel} ${n}, ${piece.label}: ${words2000}`);
    }
  }
}

/**
 * Picks for a question card from what the member said: an option label per question (1-based
 * question numbers when there's more than one). Loose matches come back `heard`.
 */
export function fillQuestions(
  questions: { question: string; options: { label: string }[]; multiSelect: boolean }[],
  current: string[][],
  answers: unknown,
): { ok: true; picks: string[][]; heard: boolean; said: string } | { ok: false; reason: string } {
  const list = asList(answers);
  if (list.length === 0) return { ok: false, reason: "Say which option they picked." };
  const picks = questions.map((_, i) => [...(current[i] ?? [])]);
  let loose = false;
  for (const raw of list) {
    const { question, option } = (typeof raw === "object" && raw ? raw : { question: 1, option: raw }) as { question?: unknown; option?: unknown };
    const qi = (spokenNumber(question ?? 1) ?? 0) - 1;
    const q = questions[qi];
    if (!q) return { ok: false, reason: `There's no question ${String(question)}.` };
    const options = asList(option);
    const labels = q.options.map((o) => o.label);
    const chosen: string[] = [];
    for (const o of options) {
      const match = typeof o === "string" ? matchOption(labels, o) : null;
      if (!match) return { ok: false, reason: `“${clip(String(o))}” isn't an option: ${labels.join(", ")}.` };
      chosen.push(match.label);
      loose ||= match.loose;
    }
    if (!q.multiSelect && chosen.length > 1) return { ok: false, reason: "That question takes one answer." };
    picks[qi] = [...new Set(chosen)];
  }
  const said = picks.map((p) => p.join(", ")).filter(Boolean).join("; ");
  return { ok: true, picks, heard: loose, said };
}

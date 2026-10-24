import { z } from "zod";
import { APPS, appForToolkit } from "@/lib/apps";
import { MAX_MANNER, companionName } from "@/lib/companion";
import { catalogEntry } from "@/lib/skills/catalog";
import { taskScheduleSchema } from "@/lib/tasks/schedule";
import { TEMPLATES } from "@/lib/templates";
import { isVoiceKey } from "@/lib/voice/voices";
import {
  ATTACHMENT_TYPES,
  MAX_FORM_FIELDS,
  MAX_FORM_FILES,
  MAX_LIST_ITEMS,
  MAX_LIST_PARTS,
  MAX_ASSUMPTIONS,
  MAX_PROPOSED_ITEMS,
  MAX_SOUND_OPTIONS,
  MAX_VERDICT_ITEMS,
  MAX_VERDICT_REASONS,
  type AgentProposal,
  type ChatMessage,
  type ProposedSkill,
  type ProposedSound,
  type ProposedTask,
  type UiBlock,
  type UiField,
  type UiForm,
  type UiHandoff,
  type UiListPart,
  type UiOffer,
  type UiOption,
  type UiSecret,
  type UiVerdictItem,
  MAX_UI_BLOCKS,
} from "@/lib/types";

// Cards the agent asked to show through its show_form, propose_agent, offer_call, and hand_browser
// tools. None changes anything: a form's answers go out as the member's next message, a proposal
// is applied only when the member clicks Apply (src/app/api/conversations/[id]/ui/[blockId]), an
// offer to call starts one only when they tap Call, and the agent's browser is the member's only
// once they tap Take over. Agent output is loose, so anything unusable is dropped rather than
// failing the whole card.

const line = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");
const para = (s: unknown, max: number) =>
  typeof s === "string" ? s.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max) : "";
const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);

/** T without its id yet, kept as a union when T is one. */
type Draft<T> = T extends unknown ? Omit<T, "id"> & { id?: unknown } : never;

/** A unique id for each entry: its own, else one made from its label. */
function ids<T extends { id: string; label: string }>(items: Draft<T>[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const { label } = item as unknown as { label: string };
    let id = slug(line(item.id, 40)) || slug(label) || "field";
    for (let n = 2; seen.has(id); n += 1) id = `${id.replace(/_\d+$/, "")}_${n}`;
    seen.add(id);
    out.push({ ...item, id } as unknown as T);
  }
  return out;
}

function options(raw: unknown): UiOption[] {
  const seen = new Set<string>();
  const out: UiOption[] = [];
  for (const o of list(raw)) {
    const label = line(typeof o === "string" ? o : isRecord(o) ? o.label : "", 80);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    const description = isRecord(o) ? line(o.description, 200) : "";
    out.push(description ? { label, description } : { label });
  }
  return out.slice(0, 8);
}

const KINDS = ["choice", "multi_choice", "text", "long_text", "file", "list", "connect", "rank", "scale", "verdict"] as const;
const KIND_ALIASES: Record<string, (typeof KINDS)[number]> = {
  select: "choice",
  radio: "choice",
  single_choice: "choice",
  multi: "multi_choice",
  multiselect: "multi_choice",
  multi_select: "multi_choice",
  checkbox: "multi_choice",
  checkboxes: "multi_choice",
  textarea: "long_text",
  paragraph: "long_text",
  longtext: "long_text",
  upload: "file",
  files: "file",
  repeat: "list",
  entries: "list",
  apps: "connect",
  order: "rank",
  ranking: "rank",
  sort: "rank",
  slider: "scale",
  rating: "scale",
  range: "scale",
  judge: "verdict",
  review: "verdict",
  keep_pass: "verdict",
  samples: "verdict",
};

const MAX_SCALE_STEPS = 10;
/** "1 = borderline too, 5 = only clear fits" (or "1: …; 10: …"): a scale's two ends in prose. */
const SCALE_ENDS = /\(?\s*\b([01])\s*=\s*([^,;=()]+?)\s*[,;]\s*(?:and\s+)?(\d{1,2})\s*=\s*([^,;=()]+?)\s*\)?\s*[.?!]?\s*$/;

/** A scale's ends written as "1 = x, 5 = y" at the end of some prose, when they make a range. */
function scaleEnds(text: string): { low: string; high: string; first: number; last: number; at: number } | null {
  const m = SCALE_ENDS.exec(text);
  if (!m) return null;
  const first = Number(m[1]);
  const last = Number(m[3]);
  return last > first ? { low: m[2], high: m[4], first, last, at: m.index } : null;
}

/** Prose with its scale ends taken out, and any separator left dangling at its end. */
const withoutEnds = (text: string, at: number) => text.slice(0, at).replace(/[\s(,:;—–-]+$/, "").trim();

/** An http(s) link, or nothing. */
function link(raw: unknown): string {
  const s = line(raw, 1000);
  try {
    const url = new URL(s);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

/** A verdict's own buttons, which models sometimes list as if they were results. */
const CALLS = /^(keep|pass|yes|no|skip|maybe|keep it|pass on it)$/i;

/** Kinds models use for a verdict's reasons as a field of their own; they join the verdict. */
const REASON_KINDS = new Set(["verdict_reasons", "pass_reasons", "reasons"]);

/** Kinds models use for read-only text in a form; their text joins the form's intro. */
const NOTE_KINDS = new Set(["note", "info", "message", "static", "paragraph_text", "callout"]);

function verdictItems(raw: unknown): UiVerdictItem[] {
  const seen = new Set<string>();
  const out: UiVerdictItem[] = [];
  for (const i of list(raw)) {
    const r = isRecord(i) ? i : { title: i };
    const title = line(r.title ?? r.label ?? r.name, 160);
    if (!title) continue;
    // A drafted post or email is the result itself, so a body holds a short draft whole.
    const body = para(r.body ?? r.description ?? r.summary ?? r.why ?? r.reason ?? r.text ?? r.content ?? r.draft, 1500);
    const href = link(r.link ?? r.url ?? r.href);
    const rec = isRecord(r.record) ? r.record : r;
    const collection = line(rec.collection, 40);
    const key = line(rec.key, 500);
    let id = slug(line(r.id, 40)) || slug(title) || "item";
    for (let n = 2; seen.has(id); n += 1) id = `${id.replace(/_\d+$/, "")}_${n}`;
    seen.add(id);
    out.push({ id, title, ...(body ? { body } : {}), ...(href ? { link: href } : {}), ...(collection && key ? { record: { collection, key } } : {}) });
  }
  return out.slice(0, MAX_VERDICT_ITEMS);
}

const LONG_PARTS = new Set(["long", "long_text", "longtext", "paragraph", "textarea"]);

function count(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === "number" ? Math.floor(raw) : Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback;
}

function field(raw: unknown): Draft<UiField> | null {
  if (!isRecord(raw)) return null;
  const kindName = line(raw.kind ?? raw.type, 30).toLowerCase();
  const kind = (KINDS as readonly string[]).includes(kindName) ? (kindName as (typeof KINDS)[number]) : KIND_ALIASES[kindName];
  const label = line(raw.label ?? raw.question ?? raw.title, 200);
  if (!kind || !label) return null;
  const help = line(raw.help ?? raw.description, 300);
  // Models often call a prefill its value or default, and an id its name or key.
  const prefillRaw = raw.prefill ?? raw.value ?? raw.default;
  const base = { id: raw.id ?? raw.name ?? raw.key, label, ...(help ? { help } : {}), required: raw.required === true };
  switch (kind) {
    case "choice":
    case "multi_choice": {
      const opts = options(raw.options ?? raw.choices);
      if (opts.length < 2) return null;
      const labels = new Set(opts.map((o) => o.label));
      const prefill = (Array.isArray(prefillRaw) ? prefillRaw : [prefillRaw]).map((p) => line(p, 80)).filter((p) => labels.has(p));
      // Choices rarely cover everything someone means, so every choice takes their own words too,
      // unless the agent turns that off for a closed question.
      const allowOther = raw.allow_other !== false && raw.allowOther !== false && raw.other !== false;
      return {
        ...base,
        kind,
        options: opts,
        ...(prefill.length ? { prefill: kind === "choice" ? prefill.slice(0, 1) : prefill } : {}),
        ...(allowOther ? { allowOther } : {}),
      };
    }
    case "rank": {
      const opts = options(raw.options ?? raw.choices ?? raw.items);
      if (opts.length < 2) return null;
      const labels = new Set(opts.map((o) => o.label));
      const order = [...new Set(list(prefillRaw).map((p) => line(p, 80)).filter((p) => labels.has(p)))];
      // A full order the agent drafted; anything short of that keeps the options' own order.
      return { ...base, kind, options: opts, ...(order.length === opts.length ? { prefill: order } : {}), required: false };
    }
    case "scale": {
      // Models also give the range as min/max and the ends inside the label or help, as
      // "1 = show me borderline ones too, 5 = only clear fits".
      const num = (v: unknown) => (typeof v === "number" ? Math.round(v) : Number.parseInt(String(v ?? ""), 10));
      const lowGiven = line(raw.low ?? raw.low_label ?? raw.lowLabel ?? raw.min_label ?? raw.minLabel ?? raw.left, 60);
      const highGiven = line(raw.high ?? raw.high_label ?? raw.highLabel ?? raw.max_label ?? raw.maxLabel ?? raw.right, 60);
      // Ends in prose are read only when the agent didn't name them, and then aren't repeated.
      const inHelp = lowGiven && highGiven ? null : scaleEnds(help);
      const inLabel = lowGiven && highGiven ? null : inHelp ? null : scaleEnds(label);
      const ends = inHelp ?? inLabel;
      const low = lowGiven || line(ends?.low, 60) || "Less";
      const high = highGiven || line(ends?.high, 60) || "More";
      const question = inLabel ? withoutEnds(label, inLabel.at) || label : label;
      const plainHelp = inHelp ? line(withoutEnds(help, inHelp.at), 300) : help;
      // The range: steps, else max - min + 1 (min may be 0), else the numbers the prose used.
      const min = Number.isFinite(num(raw.min)) && num(raw.min) >= 0 ? num(raw.min) : (ends?.first ?? 1);
      const span = num(raw.steps) || (Number.isFinite(num(raw.max)) ? num(raw.max) - min + 1 : ends ? ends.last - ends.first + 1 : 5);
      const steps = Math.max(3, Math.min(span, MAX_SCALE_STEPS));
      // A prefill on the agent's own range, moved onto 1..steps.
      const n = num(prefillRaw) - min + 1;
      return {
        id: base.id,
        label: question,
        ...(plainHelp ? { help: plainHelp } : {}),
        required: base.required,
        kind,
        steps,
        low,
        high,
        ...(n >= 1 && n <= steps ? { prefill: n } : {}),
      };
    }
    case "verdict": {
      // Models sometimes write one verdict field per result, with Keep and Pass as its options:
      // the label is then the result (buildForm gathers those into one field).
      const listed = verdictItems(raw.items ?? raw.results ?? raw.options);
      const items = listed.filter((i) => !CALLS.test(i.title));
      const passReasons = raw.reasons ?? raw.pass_reasons ?? raw.passReasons ?? raw.reasons_to_pass ?? raw.reasonsToPass;
      if (items.length === 0 && listed.length > 0) {
        const reasons = list(passReasons).map((r) => line(r, 60)).filter(Boolean).slice(0, MAX_VERDICT_REASONS);
        return { ...base, label: "Keep or pass on each", kind, items: [{ id: slug(label) || "item", title: label.slice(0, 160) }], reasons, single: true } as Draft<UiField>;
      }
      // Or with no options at all, the result and its link written into the label ("Role, Co: why. Link: https://…").
      // Only a link makes it a result: a bare "Would you want these?" is a prompt, not a result.
      const written = raw.label ?? raw.question ?? raw.title;
      const said = (typeof written === "string" ? written : "").replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "$1 $2");
      const found = said.match(/https?:\/\/[^\s<>"'\])]+/)?.[0]?.replace(/[.,;:!?]+$/, "");
      const href = listed.length === 0 ? link(raw.link ?? raw.url ?? raw.href) || link(found) : "";
      if (href) {
        const text = (found ? said.split(found).join(" ") : said)
          .replace(/\b(?:link|url|posting|source|apply here)\s*:\s*/gi, " ")
          .replace(/\(\s*\)|<\s*>|\[\s*\]|"\s*"/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .replace(/[\s.,;:]+$/, "");
        const [head, ...rest] = text.split(/:\s+/);
        const title = line(head, 160);
        // Its detail may come after the title in the label, or in the field's own description.
        const body = para(rest.join(": "), 600) || para(raw.body ?? raw.why ?? raw.summary ?? raw.description, 600);
        const reasons = list(passReasons).map((r) => line(r, 60)).filter(Boolean).slice(0, MAX_VERDICT_REASONS);
        // Without the field's help: that's this one result's detail, not the merged card's.
        const { help: _help, ...withoutHelp } = base as typeof base & { help?: string };
        if (title)
          return { ...withoutHelp, label: "Keep or pass on each", kind, items: [{ id: slug(title) || "item", title, ...(body ? { body } : {}), link: href }], reasons, single: true } as Draft<UiField>;
      }
      if (items.length === 0) return null;
      const reasons = list(passReasons)
        .map((r) => line(r, 60))
        .filter((r, i, all) => r && all.findIndex((o) => o.toLowerCase() === r.toLowerCase()) === i)
        .slice(0, MAX_VERDICT_REASONS);
      return { ...base, kind, items, reasons };
    }
    case "text":
    case "long_text": {
      const placeholder = line(raw.placeholder, 200);
      const prefill = kind === "text" ? line(prefillRaw, 500) : para(prefillRaw, 4000);
      return { ...base, kind, ...(placeholder ? { placeholder } : {}), ...(prefill ? { prefill } : {}) };
    }
    case "file": {
      const accept = list(raw.accept)
        .map((e) => line(e, 10).toLowerCase().replace(/^\./, ""))
        .filter((e) => e in ATTACHMENT_TYPES);
      return { ...base, kind, accept: accept.length ? [...new Set(accept)] : ["pdf", "docx", "txt", "md"], max: count(raw.max, 1, MAX_FORM_FILES), keep: raw.keep === true };
    }
    case "list": {
      const parts = ids<UiListPart>(
        list(raw.parts ?? raw.fields ?? raw.item_fields ?? raw.itemFields)
          .map((p): Draft<UiListPart> | null =>
            typeof p === "string"
              ? { label: line(p, 60), long: false }
              : isRecord(p)
                ? { id: p.id ?? p.key ?? p.name, label: line(p.label ?? p.name, 60), long: p.long === true || LONG_PARTS.has(line(p.kind ?? p.type, 20).toLowerCase()) }
                : null,
          )
          .filter((p): p is Draft<UiListPart> => Boolean(p?.label)),
      ).slice(0, MAX_LIST_PARTS);
      if (parts.length === 0) return null;
      const max = count(raw.max, MAX_LIST_ITEMS, MAX_LIST_ITEMS);
      // Drafts the agent wrote for the member to fix up, keyed by part id or label.
      const prefill = list(raw.prefill ?? raw.items ?? raw.entries ?? raw.value)
        .filter(isRecord)
        .map((entry) => {
          const out: Record<string, string> = {};
          for (const p of parts) {
            const value = para(entry[p.id] ?? entry[p.label] ?? entry[p.label.toLowerCase()] ?? entry[slug(p.label)], 2000);
            if (value) out[p.id] = value;
          }
          return out;
        })
        .filter((e) => Object.keys(e).length > 0)
        .slice(0, max);
      const itemLabel = line(raw.item_label ?? raw.itemLabel, 40) || "Entry";
      return { ...base, kind, parts, itemLabel, max, ...(prefill.length ? { prefill } : {}) };
    }
    case "connect": {
      // One app per field ({app: "gmail"}, or just the field's name) is as common as a list, and
      // Composio's toolkit names ("googlecalendar") as common as app ids.
      const strings = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []);
      let named = [raw.apps, raw.app, raw.toolkit].flatMap(strings);
      if (named.length === 0) named = [raw.id, raw.name, raw.key].flatMap(strings);
      const apps = [...new Set(named.map((a) => line(a, 30).toLowerCase()).map((a) => (a in APPS ? a : appForToolkit(a))))].filter((a) => a in APPS).slice(0, 6);
      return apps.length ? { ...base, kind, apps, required: false } : null;
    }
  }
}

/** One-result verdict fields (see field()) gathered into one, where the first of them was. */
function gatherVerdicts(fields: Draft<UiField>[]): Draft<UiField>[] {
  const singles = fields.filter((f) => (f as { single?: boolean }).single);
  const strip = ({ single: _single, ...f }: Draft<UiField> & { single?: boolean }) => f as Draft<UiField>;
  if (singles.length < 2) return fields.map(strip);
  const seen = new Set<string>();
  const items = singles.flatMap((f) => (f.kind === "verdict" ? f.items : [])).map((item) => {
    let id = item.id;
    for (let n = 2; seen.has(id); n += 1) id = `${item.id}_${n}`;
    seen.add(id);
    return { ...item, id };
  });
  const reasons = singles
    .flatMap((f) => (f.kind === "verdict" ? f.reasons : []))
    .filter((r, i, all) => all.findIndex((o) => o.toLowerCase() === r.toLowerCase()) === i)
    .slice(0, MAX_VERDICT_REASONS);
  const merged = { ...strip(singles[0]), items: items.slice(0, MAX_VERDICT_ITEMS), reasons, required: singles.some((f) => f.required) } as Draft<UiField>;
  return fields.flatMap((f) => (f === singles[0] ? [merged] : singles.includes(f) ? [] : [strip(f)]));
}

function buildForm(raw: Record<string, unknown>, id: string): UiForm | null {
  const title = line(raw.title, 120);
  const rawFields = list(raw.fields);
  const notes = rawFields
    .filter((f) => isRecord(f) && NOTE_KINDS.has(line(f.kind ?? f.type, 30).toLowerCase()))
    .map((f) => para((f as Record<string, unknown>).value ?? (f as Record<string, unknown>).text ?? (f as Record<string, unknown>).prefill ?? (f as Record<string, unknown>).label, 400))
    .filter(Boolean);
  const reasons = rawFields
    .filter((f) => isRecord(f) && REASON_KINDS.has(line(f.kind ?? f.type, 30).toLowerCase()))
    .flatMap((f) => list((f as Record<string, unknown>).items ?? (f as Record<string, unknown>).options ?? (f as Record<string, unknown>).reasons))
    .map((r) => line(r, 60))
    .filter(Boolean);
  const drafts = rawFields.map(field).filter((f): f is Draft<UiField> => Boolean(f));
  const withReasons = drafts.map((f) =>
    f.kind === "verdict" && reasons.length
      ? { ...f, reasons: [...f.reasons, ...reasons].filter((r, i, all) => all.findIndex((o) => o.toLowerCase() === r.toLowerCase()) === i).slice(0, MAX_VERDICT_REASONS) }
      : f,
  );
  const fields = ids<UiField>(gatherVerdicts(withReasons)).slice(0, MAX_FORM_FIELDS);
  if (!title || fields.length === 0) return null;
  const intro = para([raw.intro, ...notes].filter((x) => typeof x === "string" && x.trim()).join("\n\n"), 900);
  return { kind: "form", id, title, ...(intro ? { intro } : {}), fields, submitLabel: line(raw.submit_label ?? raw.submitLabel, 30) || "Send" };
}

function skill(raw: unknown): ProposedSkill | null {
  const id = typeof raw === "string" ? raw : isRecord(raw) ? (raw.catalog_id ?? raw.catalogId ?? raw.id) : null;
  if (typeof id === "string" && catalogEntry(id.trim())) return { catalogId: id.trim() };
  if (!isRecord(raw)) return null;
  const name = line(raw.name, 80);
  const instructions = para(raw.instructions, 4000);
  return name && instructions ? { name, description: line(raw.description, 200), instructions } : null;
}

const TEMPLATE_TASKS = new Map(TEMPLATES.flatMap((t) => t.tasks.map((task) => [task.id, task.title] as const)));

function task(raw: unknown): ProposedTask | null {
  if (!isRecord(raw)) return null;
  const templateTaskId = line(raw.template_task_id ?? raw.templateTaskId, 60);
  // Switching on a template task by its id alone keeps that task's own title.
  const title = line(raw.title ?? raw.name, 80) || (templateTaskId ? (TEMPLATE_TASKS.get(templateTaskId) ?? "") : "");
  if (!title) return null;
  const schedule = taskScheduleSchema.safeParse(scheduleFrom(raw.schedule));
  const skillId = line(raw.skill, 60);
  return {
    ...(templateTaskId ? { templateTaskId } : {}),
    title,
    instructions: para(raw.instructions ?? raw.description, 4000),
    ...(skillId && catalogEntry(skillId) ? { skill: skillId } : {}),
    schedule: schedule.success ? schedule.data : null,
  };
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const PARTS_OF_DAY: Record<string, string> = { morning: "08:00", noon: "12:00", midday: "12:00", afternoon: "14:00", evening: "18:00" };

/** "8", "8:30", "8am", "08:00", "2:15 PM" as a 24-hour HH:MM, or the input when it isn't a time. */
function clock(raw: unknown): unknown {
  const m = typeof raw === "string" ? /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\.?\s*$/i.exec(raw) : null;
  if (!m) return raw;
  let h = Number(m[1]);
  if (m[3]) h = (h % 12) + (m[3].toLowerCase() === "p" ? 12 : 0);
  return `${String(h).padStart(2, "0")}:${m[2] ?? "00"}`;
}

/**
 * A schedule as the agent wrote it, in the stored shape when it can be read: the object form
 * with loose values ("weekday", "8am", weekday "Monday"), or a phrase like "Weekdays at 8:00
 * AM", "Every Monday at 9", "Daily at 7pm", "Every 4 hours". Anything else stays as it was.
 */
export function scheduleFrom(raw: unknown): unknown {
  // "On demand" in its many spellings: no schedule.
  const onDemand = (v: unknown) => typeof v === "string" && /^(on[ -_]?demand|manual(ly)?|none|never|when (i|you) ask)$/i.test(v.trim());
  if (isRecord(raw) && (raw.on_demand === true || raw.onDemand === true || raw.manual === true || onDemand(raw.every))) return null;
  if (onDemand(raw)) return null;
  if (isRecord(raw)) {
    const every = line(raw.every, 20).toLowerCase();
    const kind = ({ daily: "day", weekday: "weekdays", weekly: "week", hourly: "hours" } as Record<string, string>)[every] ?? every;
    // A weekday as `every` ({every: "monday"}) means once a week on that day.
    const everyDay = every.length >= 3 ? WEEKDAYS.findIndex((d) => d.startsWith(every.replace(/s$/, "").slice(0, 3))) : -1;
    if (everyDay >= 0 && raw.weekday === undefined && raw.day === undefined && raw.day_of_week === undefined)
      return { every: "week", at: clock(raw.at), weekday: everyDay };
    const named = raw.weekday ?? raw.day ?? raw.day_of_week;
    const day = line(named, 20).toLowerCase().slice(0, 3);
    const weekday = typeof named === "string" && day ? WEEKDAYS.findIndex((d) => d.startsWith(day)) : named;
    if (kind === "day" || kind === "weekdays") return { every: kind, at: clock(raw.at) };
    if (kind === "week") return { every: kind, at: clock(raw.at), weekday };
    if (kind === "hours") return { every: kind, hours: raw.hours === undefined ? 1 : Number(raw.hours) };
    return raw;
  }
  if (typeof raw !== "string") return raw;
  // "Weekdays, morning" and "every Monday in the evening" name a time of day instead of a clock.
  let s = raw.trim().toLowerCase().replace(/,/g, " ");
  if (!/\d/.test(s)) s = s.replace(/\b(?:in the |at )?(morning|noon|midday|afternoon|evening)s?\b/, (_, part: string) => ` ${PARTS_OF_DAY[part]}`);
  s = s.replace(/\s+/g, " ").trim();
  const hours = /^every\s+(\d{1,2})\s+hours?$/.exec(s) ?? (s === "hourly" || s === "every hour" ? ["", "1"] : null);
  if (hours) return { every: "hours", hours: Number(hours[1]) };
  const m = /^(?:every\s+|each\s+|on\s+|weekly\s+on\s+)?([a-z]+?)s?(?:\s+mornings?)?(?:\s+at\s+|\s+)(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)$/.exec(s);
  if (!m) return raw;
  const at = clock(m[2]);
  const when = m[1];
  if (when === "day" || when === "daily") return { every: "day", at };
  if (when === "weekday") return { every: "weekdays", at };
  const day = WEEKDAYS.findIndex((d) => d === when || (when.length >= 3 && d.startsWith(when)));
  if (day >= 0) return { every: "week", at, weekday: day };
  return raw;
}

/** One way it could sound: a voice from Studio's catalog (anything else is dropped) and how it'd talk. */
function sound(raw: unknown): ProposedSound | null {
  if (!isRecord(raw)) return null;
  const voice = line(raw.voice ?? raw.key, 40).toLowerCase();
  return isVoiceKey(voice) ? { voice, manner: para(raw.manner ?? raw.style, MAX_MANNER) } : null;
}

function buildProposal(raw: Record<string, unknown>, id: string): AgentProposal | null {
  const summary = para(raw.summary, 600);
  const profile = para(raw.profile, 8000);
  const instructions = para(raw.instructions, 8000);
  const skills = list(raw.skills).map(skill).filter((s): s is ProposedSkill => Boolean(s));
  const uniqueSkills = skills.filter((s, i) => !("catalogId" in s) || skills.findIndex((o) => "catalogId" in o && o.catalogId === s.catalogId) === i);
  const tasks = list(raw.tasks).map(task).filter((t): t is ProposedTask => Boolean(t));
  const memories = [...new Set(list(raw.memories).map((m) => line(m, 500)).filter(Boolean))];
  const self = isRecord(raw.identity) ? raw.identity : null;
  const name = self ? companionName(self.name) : null;
  const identity = name ? { name, manner: para(self?.manner, MAX_MANNER) } : undefined;
  // A list of options, one option alone, or the options under a key.
  const soundRaw = isRecord(raw.sound) ? (Array.isArray(raw.sound.options) ? raw.sound.options : [raw.sound]) : list(raw.sound);
  const sounds = soundRaw.map(sound).filter((o): o is ProposedSound => Boolean(o));
  const options = sounds.filter((o, i) => sounds.findIndex((p) => p.voice === o.voice && p.manner === o.manner) === i).slice(0, MAX_SOUND_OPTIONS);
  // Its guesses, for the member to check: only with something to apply that they're about.
  const assumptions = [...new Set(list(raw.assumptions ?? raw.guesses).map((a) => line(a, 300)).filter(Boolean))].slice(0, MAX_ASSUMPTIONS);
  const proposal: AgentProposal = {
    kind: "proposal",
    id,
    summary,
    ...(profile ? { profile } : {}),
    ...(instructions ? { instructions } : {}),
    skills: uniqueSkills.slice(0, MAX_PROPOSED_ITEMS),
    tasks: tasks.slice(0, MAX_PROPOSED_ITEMS),
    memories: memories.slice(0, MAX_PROPOSED_ITEMS),
    ...(identity ? { identity } : {}),
    ...(options.length ? { sound: options } : {}),
    ...(assumptions.length ? { assumptions } : {}),
  };
  const empty = !profile && !instructions && !proposal.skills.length && !proposal.tasks.length && !proposal.memories.length && !identity && !options.length;
  return empty ? null : proposal;
}

/**
 * Whether a card the agent asked for is a proposed merge of remembered facts (`{memory_merge}`).
 * Those are checked against the member's memory (src/lib/memory-merge.ts), not here.
 */
export function isMergeRequest(raw: unknown): raw is { memory_merge: Record<string, unknown> } {
  return isRecord(raw) && isRecord(raw.memory_merge);
}

/** The agent's offer to talk it through on a call: why, in one sentence (required), and what about. */
export function buildOffer(raw: Record<string, unknown>, id: string = crypto.randomUUID()): UiOffer | null {
  const reason = line(raw.reason, 200);
  if (!reason) return null;
  const topic = line(raw.topic, 80);
  return { kind: "offer", id, reason, ...(topic ? { topic } : {}) };
}

/** The agent's browser, handed to the member: what they need to do there (required), where, and whether it's to show it a job (watch_me). */
export function buildHandoff(raw: Record<string, unknown>, id: string = crypto.randomUUID()): UiHandoff | null {
  const reason = line(raw.reason, 200);
  if (!reason) return null;
  const site = line(raw.site, 40);
  return { kind: "browser", id, reason, ...(site ? { site } : {}), ...(raw.watch === true ? { watch: true } : {}) };
}

/** The agent asking for a login, card, or one-time code at its browser: which, and why. It never carries a secret. */
export function buildSecretRequest(raw: Record<string, unknown>, id: string = crypto.randomUUID()): UiSecret | null {
  const secret = raw.kind === "login" || raw.kind === "card" || raw.kind === "code" ? raw.kind : null;
  const reason = line(raw.reason, 200);
  if (!secret || !reason) return null;
  const usernameHint = secret === "login" ? line(raw.username_hint ?? raw.usernameHint, 200) : "";
  return { kind: "secret", id, secret, reason, ...(usernameHint ? { usernameHint } : {}) };
}

/** Validates one card the agent asked for (`{form}`, `{proposal}`, `{offer_call}`, `{secret_request}`, or `{hand_browser}`). Null when nothing is usable. */
export function buildUiBlock(raw: unknown, id: string = crypto.randomUUID()): UiBlock | null {
  if (!isRecord(raw)) return null;
  if (isRecord(raw.form)) return buildForm(raw.form, id);
  if (isRecord(raw.proposal)) return buildProposal(raw.proposal, id);
  if (isRecord(raw.offer_call)) return buildOffer(raw.offer_call, id);
  if (isRecord(raw.secret_request)) return buildSecretRequest(raw.secret_request, id);
  if (isRecord(raw.hand_browser)) return buildHandoff(raw.hand_browser, id);
  return null;
}

/**
 * The cards a reply keeps: its latest MAX_UI_BLOCKS forms and proposals, then its latest offer
 * to call, last. An offer never pushes out a card that asks something of the member (a form
 * and an offer in one reply both stay), and one is enough.
 */
export function capUi(blocks: UiBlock[]): UiBlock[] {
  const offer = blocks.findLast((b) => b.kind === "offer");
  return [...blocks.filter((b) => b.kind !== "offer").slice(-MAX_UI_BLOCKS), ...(offer ? [offer] : [])];
}

/** Cards newer than some open pages: offers to call, requests for a login or card, and the browser handed over. */
export type NewerCard = Extract<UiBlock["kind"], "offer" | "secret" | "browser">;

/** The newer cards a page can't show, from what it says it knows (an open tab keeps its old code across a deploy). */
export function unknownCards(knows: { offers?: boolean; secrets?: boolean; handoffs?: boolean }): NewerCard[] {
  return [
    ...(knows.offers ? [] : (["offer"] as const)),
    ...(knows.secrets ? [] : (["secret"] as const)),
    ...(knows.handoffs ? [] : (["browser"] as const)),
  ];
}

/**
 * Messages as a page from before some cards reads them: without those cards, or what the member
 * did with one. Such a page draws any card it doesn't know as a proposed setup and breaks on it,
 * so only pages that say they know a kind get it.
 */
export function withoutCards(messages: ChatMessage[], kinds: readonly NewerCard[]): ChatMessage[] {
  if (!kinds.length) return messages;
  const hidden = (b: UiBlock) => (kinds as readonly string[]).includes(b.kind);
  return messages.map((m) => {
    const gone = (m.ui ?? []).filter(hidden).map((b) => b.id);
    if (!gone.length) return m;
    const ui = m.ui!.filter((b) => !hidden(b));
    const uiResponse = m.uiResponse ? Object.fromEntries(Object.entries(m.uiResponse).filter(([id]) => !gone.includes(id))) : undefined;
    return { ...m, ui, ...(uiResponse ? { uiResponse } : {}) };
  });
}

/** Messages as a page from before offers to call (and the cards after them) reads them. */
export function withoutOffers(messages: ChatMessage[]): ChatMessage[] {
  return withoutCards(messages, ["offer", "secret", "browser"]);
}

export const proposalPicksSchema = z.strictObject({
  profile: z.boolean(),
  instructions: z.boolean(),
  skills: z.array(z.number().int().min(0).max(MAX_PROPOSED_ITEMS)).max(MAX_PROPOSED_ITEMS),
  tasks: z.array(z.number().int().min(0).max(MAX_PROPOSED_ITEMS)).max(MAX_PROPOSED_ITEMS),
  memories: z.array(z.number().int().min(0).max(MAX_PROPOSED_ITEMS)).max(MAX_PROPOSED_ITEMS),
  identity: z.boolean().optional(),
  sound: z.number().int().min(0).max(MAX_SOUND_OPTIONS - 1).optional(),
});

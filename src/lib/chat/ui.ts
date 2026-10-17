import { z } from "zod";
import { APPS } from "@/lib/apps";
import { catalogEntry } from "@/lib/skills/catalog";
import { taskScheduleSchema } from "@/lib/tasks/schedule";
import {
  ATTACHMENT_TYPES,
  MAX_FORM_FIELDS,
  MAX_FORM_FILES,
  MAX_LIST_ITEMS,
  MAX_LIST_PARTS,
  MAX_PROPOSED_ITEMS,
  type AgentProposal,
  type ProposedSkill,
  type ProposedTask,
  type UiBlock,
  type UiField,
  type UiForm,
  type UiListPart,
  type UiOption,
} from "@/lib/types";

// Cards the agent asked to show through its show_form and propose_agent tools. Neither tool
// changes anything: a form's answers go out as the member's next message, and a proposal is
// applied only when the member clicks Apply (src/app/api/conversations/[id]/ui/[blockId]).
// Agent output is loose, so anything unusable is dropped rather than failing the whole card.

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

const KINDS = ["choice", "multi_choice", "text", "long_text", "file", "list", "connect"] as const;
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
};

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
  const base = { id: raw.id, label, ...(help ? { help } : {}), required: raw.required === true };
  switch (kind) {
    case "choice":
    case "multi_choice": {
      const opts = options(raw.options ?? raw.choices);
      if (opts.length < 2) return null;
      const labels = new Set(opts.map((o) => o.label));
      const prefill = (Array.isArray(raw.prefill) ? raw.prefill : [raw.prefill]).map((p) => line(p, 80)).filter((p) => labels.has(p));
      return { ...base, kind, options: opts, ...(prefill.length ? { prefill: kind === "choice" ? prefill.slice(0, 1) : prefill } : {}) };
    }
    case "text":
    case "long_text": {
      const placeholder = line(raw.placeholder, 200);
      const prefill = kind === "text" ? line(raw.prefill, 500) : para(raw.prefill, 4000);
      return { ...base, kind, ...(placeholder ? { placeholder } : {}), ...(prefill ? { prefill } : {}) };
    }
    case "file": {
      const accept = list(raw.accept)
        .map((e) => line(e, 10).toLowerCase().replace(/^\./, ""))
        .filter((e) => e in ATTACHMENT_TYPES);
      return { ...base, kind, accept: accept.length ? [...new Set(accept)] : ["pdf", "docx", "txt", "md"], max: count(raw.max, 1, MAX_FORM_FILES) };
    }
    case "list": {
      const parts = ids<UiListPart>(
        list(raw.parts ?? raw.fields)
          .map((p): Draft<UiListPart> | null =>
            typeof p === "string" ? { label: line(p, 60), long: false } : isRecord(p) ? { id: p.id, label: line(p.label, 60), long: p.long === true || p.kind === "long_text" } : null,
          )
          .filter((p): p is Draft<UiListPart> => Boolean(p?.label)),
      ).slice(0, MAX_LIST_PARTS);
      if (parts.length === 0) return null;
      const max = count(raw.max, MAX_LIST_ITEMS, MAX_LIST_ITEMS);
      // Drafts the agent wrote for the member to fix up, keyed by part id or label.
      const prefill = list(raw.prefill)
        .filter(isRecord)
        .map((entry) => {
          const out: Record<string, string> = {};
          for (const p of parts) {
            const value = para(entry[p.id] ?? entry[p.label] ?? entry[p.label.toLowerCase()], 2000);
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
      const apps = [...new Set(list(raw.apps).map((a) => line(a, 30).toLowerCase()))].filter((a) => a in APPS).slice(0, 6);
      return apps.length ? { ...base, kind, apps, required: false } : null;
    }
  }
}

function buildForm(raw: Record<string, unknown>, id: string): UiForm | null {
  const title = line(raw.title, 120);
  const fields = ids<UiField>(list(raw.fields).map(field).filter((f): f is Draft<UiField> => Boolean(f))).slice(0, MAX_FORM_FIELDS);
  if (!title || fields.length === 0) return null;
  const intro = para(raw.intro, 600);
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

function task(raw: unknown): ProposedTask | null {
  if (!isRecord(raw)) return null;
  const title = line(raw.title, 80);
  if (!title) return null;
  const schedule = taskScheduleSchema.safeParse(raw.schedule);
  const skillId = line(raw.skill, 60);
  const templateTaskId = line(raw.template_task_id ?? raw.templateTaskId, 60);
  return {
    ...(templateTaskId ? { templateTaskId } : {}),
    title,
    instructions: para(raw.instructions, 4000),
    ...(skillId && catalogEntry(skillId) ? { skill: skillId } : {}),
    schedule: schedule.success ? schedule.data : null,
  };
}

function buildProposal(raw: Record<string, unknown>, id: string): AgentProposal | null {
  const summary = para(raw.summary, 600);
  const profile = para(raw.profile, 8000);
  const instructions = para(raw.instructions, 8000);
  const skills = list(raw.skills).map(skill).filter((s): s is ProposedSkill => Boolean(s));
  const uniqueSkills = skills.filter((s, i) => !("catalogId" in s) || skills.findIndex((o) => "catalogId" in o && o.catalogId === s.catalogId) === i);
  const tasks = list(raw.tasks).map(task).filter((t): t is ProposedTask => Boolean(t));
  const memories = [...new Set(list(raw.memories).map((m) => line(m, 500)).filter(Boolean))];
  const proposal: AgentProposal = {
    kind: "proposal",
    id,
    summary,
    ...(profile ? { profile } : {}),
    ...(instructions ? { instructions } : {}),
    skills: uniqueSkills.slice(0, MAX_PROPOSED_ITEMS),
    tasks: tasks.slice(0, MAX_PROPOSED_ITEMS),
    memories: memories.slice(0, MAX_PROPOSED_ITEMS),
  };
  const empty = !profile && !instructions && !proposal.skills.length && !proposal.tasks.length && !proposal.memories.length;
  return empty ? null : proposal;
}

/** Validates one card the agent asked for (`{form}` or `{proposal}`). Null when nothing is usable. */
export function buildUiBlock(raw: unknown, id: string = crypto.randomUUID()): UiBlock | null {
  if (!isRecord(raw)) return null;
  if (isRecord(raw.form)) return buildForm(raw.form, id);
  if (isRecord(raw.proposal)) return buildProposal(raw.proposal, id);
  return null;
}

export const proposalPicksSchema = z.strictObject({
  profile: z.boolean(),
  instructions: z.boolean(),
  skills: z.array(z.number().int().min(0).max(MAX_PROPOSED_ITEMS)).max(MAX_PROPOSED_ITEMS),
  tasks: z.array(z.number().int().min(0).max(MAX_PROPOSED_ITEMS)).max(MAX_PROPOSED_ITEMS),
  memories: z.array(z.number().int().min(0).max(MAX_PROPOSED_ITEMS)).max(MAX_PROPOSED_ITEMS),
});

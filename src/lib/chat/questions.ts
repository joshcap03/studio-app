import { z } from "zod";
import { MAX_QUESTION_OPTIONS, MAX_QUESTIONS, type Question } from "@/lib/types";

// Multiple-choice questions the agent asked through its ask_user tool. They change nothing:
// the member's pick is sent as their next message, like anything they'd type.

const text = (max: number) => z.string().transform((s) => s.replace(/\s+/g, " ").trim().slice(0, max));

const rawSchema = z
  .array(
    z.object({
      question: text(300),
      header: text(30).optional().catch(undefined),
      options: z
        .array(
          z.preprocess(
            (o) => (typeof o === "string" ? { label: o } : o),
            z.object({ label: text(80), description: text(200).optional().catch(undefined) }),
          ),
        )
        .max(MAX_QUESTION_OPTIONS * 2),
      multi_select: z.boolean().optional().catch(undefined),
      multiSelect: z.boolean().optional().catch(undefined),
    }),
  )
  .max(MAX_QUESTIONS * 2);

/** Validates the agent's questions. Null when there's nothing usable. */
export function buildQuestions(raw: unknown): Question[] | null {
  const list = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { questions?: unknown }).questions : raw;
  const parsed = rawSchema.safeParse(list);
  if (!parsed.success) return null;
  const out: Question[] = [];
  for (const q of parsed.data) {
    const seen = new Set<string>();
    const options = q.options
      .filter((o) => o.label && !seen.has(o.label.toLowerCase()) && seen.add(o.label.toLowerCase()))
      .slice(0, MAX_QUESTION_OPTIONS)
      .map((o) => (o.description ? { label: o.label, description: o.description } : { label: o.label }));
    if (!q.question || options.length < 2) continue;
    out.push({ question: q.question, ...(q.header ? { header: q.header } : {}), options, multiSelect: Boolean(q.multi_select ?? q.multiSelect) });
    if (out.length === MAX_QUESTIONS) break;
  }
  return out.length ? out : null;
}

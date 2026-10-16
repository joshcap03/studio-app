import { z } from "zod";
import type { Evidence } from "@/lib/agent/tools/evidence";
import { safeUrl } from "@/lib/agent/tools/sanitize";
import { MAX_CITATIONS, type Citation } from "@/lib/types";

// The sources an answer cites as [n], as the agent reported them through its cite tool.
// A citation is kept only when this run's tools returned its link. Its quote is checked
// against the text the tool returned for that link: found means verified, otherwise the
// citation is kept as link-only and shown that way. Nothing here trusts the agent's word.

const ALIASES = {
  n: ["n", "number", "id", "index"],
  url: ["url", "link", "href"],
  quote: ["quote", "text", "excerpt", "passage", "snippet"],
} as const;

function normalizeSource(e: unknown): unknown {
  if (!e || typeof e !== "object") return e;
  const r = e as Record<string, unknown>;
  return Object.fromEntries(Object.entries(ALIASES).map(([key, names]) => [key, names.map((n) => r[n]).find((v) => v != null && v !== "")]));
}

const rawSchema = z.object({
  sources: z
    .array(
      z.preprocess(
        normalizeSource,
        z.object({
          n: z.coerce.number().int().min(1).max(99),
          url: z.string(),
          quote: z.string().transform((s) => s.replace(/\s+/g, " ").trim().slice(0, 300)),
        }),
      ).optional().catch(undefined),
    )
    .max(MAX_CITATIONS * 2),
});

/** Validates the agent's citations against what this run's tools returned. */
export function buildCitations(raw: unknown, evidence: Evidence[], seen: Set<string>): Citation[] | null {
  const parsed = rawSchema.safeParse(raw);
  if (!parsed.success) return null;
  const byUrl = new Map(evidence.map((e) => [e.url, e]));
  const out = new Map<number, Citation>();
  for (const source of parsed.data.sources) {
    if (!source || out.has(source.n) || source.quote.length < 3) continue;
    const url = safeUrl(source.url);
    const found = url ? byUrl.get(url) : undefined;
    if (!url || (!found && !seen.has(url))) continue;
    out.set(source.n, {
      n: source.n,
      url,
      quote: source.quote,
      quoteVerified: Boolean(found && quoted(source.quote, found.text)),
      ...(found?.title ? { title: found.title } : {}),
      ...(found?.app && found.app !== "agent" ? { app: found.app } : {}),
    });
    if (out.size >= MAX_CITATIONS) break;
  }
  if (out.size === 0) return null;
  return [...out.values()].sort((a, b) => a.n - b.n);
}

/** True when the quote appears in the text, ignoring case, spacing, markup and quote styles. */
export function quoted(quote: string, text: string): boolean {
  const q = normalize(quote).replace(/^[.…]+|[.…]+$/g, "").trim();
  return q.length >= 3 && normalize(text).includes(q);
}

function normalize(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/[*_`#>|]+/g, " ")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

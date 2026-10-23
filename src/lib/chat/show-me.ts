import { MAX_SHOWN_NOTES, MAX_SHOWN_STEPS, type ShownNote, type ShownStep, type UiHandoff } from "@/lib/types";

// "Show me once": the member does a job in the agent's browser while Studio notes each step (the
// server says what each input was done to; src/lib/browser-fill.ts) and what they say, typed as a
// note or said on a call. Their Done sends it all as their next message, so they see exactly what
// the agent gets, and the agent writes it up as a skill with its guesses for them to check. Steps
// are tidied the way a person would retell them: scrolling and repeated keys fold into one, and
// typing into one field in several goes reads as one. Pure, for the card and tests.

/** One line of the retelling: a step, or something they said along the way. */
export type ShownLine = { kind: "step"; text: string; page?: string } | { kind: "note"; text: string };

const where = (page: ShownStep["page"]) => {
  const url = page.url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
  if (page.title && url) return `“${page.title}” (${url})`;
  return page.title ? `“${page.title}”` : url;
};

const samePage = (a: ShownStep["page"], b: ShownStep["page"]) => a.url === b.url && a.title === b.title;

function say(step: ShownStep): string {
  const on = step.target ? ` ${step.target}` : "";
  switch (step.action) {
    case "click":
      return `Clicked${on || " the page"}`;
    case "type":
      if (step.hidden) return `Typed into${on || " a field"} (hidden: not recorded)`;
      return `Typed “${step.text ?? ""}”${step.target ? ` into ${step.target}` : ""}`;
    case "key":
      return `Pressed ${step.key}`;
    case "scroll":
      return (step.dy ?? 0) < 0 ? "Scrolled up" : "Scrolled down";
    default:
      return "";
  }
}

/** Steps folded the way a person retells them: one scroll, one bit of typing per field, one run of a key. */
export function foldSteps(steps: ShownStep[]): ShownStep[] {
  const out: ShownStep[] = [];
  let repeats = 1;
  for (const step of steps.filter((s) => s.action !== "look")) {
    const last = out.at(-1);
    if (last && samePage(last.page, step.page)) {
      if (last.action === "scroll" && step.action === "scroll" && Math.sign(last.dy ?? 0) === Math.sign(step.dy ?? 0)) continue;
      if (last.action === "type" && step.action === "type" && last.target === step.target && !last.hidden && !step.hidden) {
        out[out.length - 1] = { ...last, text: `${last.text ?? ""}${step.text ?? ""}` };
        continue;
      }
      if (last.action === "type" && step.action === "type" && last.target === step.target && last.hidden && step.hidden) continue;
      if (last.action === "key" && step.action === "key" && last.key === step.key) {
        repeats += 1;
        out[out.length - 1] = { ...last, key: `${step.key} ×${repeats}` };
        continue;
      }
    }
    repeats = 1;
    out.push(step);
  }
  return out;
}

/** What they showed, in order: each step (with the page, when it changed), and their notes where they said them. */
export function shownLines(steps: ShownStep[], notes: ShownNote[]): ShownLine[] {
  const folded = foldSteps(steps.slice(0, MAX_SHOWN_STEPS));
  const said = [...notes.slice(0, MAX_SHOWN_NOTES)].sort((a, b) => a.at - b.at);
  const lines: ShownLine[] = [];
  let page: ShownStep["page"] | null = null;
  let n = 0;
  const notesUntil = (at: number) => {
    while (n < said.length && said[n].at <= at) lines.push({ kind: "note", text: said[n++].text });
  };
  for (const step of folded) {
    notesUntil(step.at);
    const moved = !page || !samePage(page, step.page);
    page = step.page;
    lines.push({ kind: "step", text: say(step), ...(moved && where(step.page) ? { page: where(step.page) } : {}) });
  }
  notesUntil(Infinity);
  return lines;
}

/** Where the showing started and ended, from its looks (or its first and last steps). */
function ends(steps: ShownStep[]): { start: string; end: string } {
  const start = steps[0] ? where(steps[0].page) : "";
  const end = steps.at(-1) ? where(steps.at(-1)!.page) : "";
  return { start, end };
}

/**
 * The member's Done, as their next message: the job, each step on its page, what they said along
 * the way, and the ask to write it up. Names in quotes are the page's own words, as the page
 * showed them.
 */
export function shownText(handoff: Pick<UiHandoff, "reason" | "site">, steps: ShownStep[], notes: ShownNote[]): string {
  const lines = shownLines(steps, notes);
  const { start, end } = ends(steps);
  const count = lines.filter((l) => l.kind === "step").length;
  if (!count) {
    const said = lines.map((l) => `- “${l.text}”`);
    return [
      `I didn't get to show you in the browser${handoff.site ? ` on ${handoff.site}` : ""}.`,
      ...(said.length ? ["", "What I said:", ...said] : []),
    ].join("\n");
  }
  let i = 0;
  const body = lines.map((l) => {
    // A note said along the way sits under the step it followed.
    if (l.kind === "note") return `${i ? "   " : ""}I said: “${l.text}”`;
    i += 1;
    return `${i}. ${l.page ? `On ${l.page}: ` : ""}${l.text}`;
  });
  return [
    `I've shown you how I do it${handoff.site ? ` on ${handoff.site}` : ""}. Here's what I did (names in quotes are as the page showed them):`,
    "",
    ...body,
    ...(end && end !== start ? ["", `It ended on ${end}.`] : []),
    "",
    "Write it up as a skill for me to check, with your guesses.",
  ].join("\n");
}

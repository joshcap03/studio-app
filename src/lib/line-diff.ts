// A small line diff, for reading what changed in an agent's brief or a skill: what a proposal would
// change, and how a past version differs from now. Texts are at most a few thousand characters.

export type DiffLine = { kind: "same" | "gone" | "new"; text: string };

/** Past this many line pairs, the whole of each side is shown rather than a careful diff. */
const MAX_CELLS = 400_000;

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    return [...a.map((text): DiffLine => ({ kind: "gone", text })), ...b.map((text): DiffLine => ({ kind: "new", text }))];
  }
  // Longest common subsequence, from the end, so the walk below reads forward.
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i * width + j] = a[i] === b[j] ? lengths[(i + 1) * width + j + 1] + 1 : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
      out.push({ kind: "gone", text: a[i++] });
    } else {
      out.push({ kind: "new", text: b[j++] });
    }
  }
  return out;
}

/** Runs of unchanged lines longer than `keep` on each side fold to a count. */
export function foldDiff(lines: DiffLine[], keep = 2): (DiffLine | { kind: "fold"; count: number })[] {
  const out: (DiffLine | { kind: "fold"; count: number })[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "same") {
      out.push(lines[i++]);
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end].kind === "same") end++;
    const lead = i === 0 ? 0 : keep;
    const trail = end === lines.length ? 0 : keep;
    if (end - i > lead + trail + 1) {
      out.push(...lines.slice(i, i + lead), { kind: "fold", count: end - i - lead - trail }, ...lines.slice(end - trail, end));
    } else {
      out.push(...lines.slice(i, end));
    }
    i = end;
  }
  return out;
}

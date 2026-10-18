import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Studio should feel like a game, never look like one: progress, a clear next move and a real
// first win, without the vocabulary. These words stay out of everything a member reads and out
// of what the agent is told, so it doesn't pick them up either.
const GAME_WORDS = /\b(quests?|xp|streaks?|badges?|achievements?|unlock(?:s|ed|ing)?|level(?:s|ed)? up|leaderboards?|confetti)\b/i;

const ROOT = join(__dirname, "..", "..");

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return ext.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** What a component shows: JSX text and string literals with a space in them (prose, not ids). */
function shownText(source: string): string[] {
  const jsx = [...source.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)].map((m) => m[1]);
  const strings = [...source.matchAll(/"([^"\n]*\s[^"\n]*)"|'([^'\n]*\s[^'\n]*)'|`([^`$]*\s[^`$]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  return [...jsx, ...strings];
}

function hits(path: string, texts: string[]): string[] {
  return texts.filter((t) => GAME_WORDS.test(t)).map((t) => `${relative(ROOT, path)}: ${t.trim().slice(0, 120)}`);
}

describe("game feel, not game look", () => {
  it("keeps game words out of the agent's instructions, skills, and templates", () => {
    const prompts = [join(ROOT, "langflow", "agent_instructions.md"), ...files(join(ROOT, "src", "lib", "skills"), /\.ts$/), ...files(join(ROOT, "src", "lib", "templates"), /\.ts$/)];
    expect(prompts.flatMap((p) => hits(p, [readFileSync(p, "utf8")]).map(() => `${relative(ROOT, p)}: ${readFileSync(p, "utf8").match(GAME_WORDS)![0]}`))).toEqual([]);
  });

  it("keeps game words out of what members read in the app", () => {
    const components = [...files(join(ROOT, "src", "components"), /\.tsx$/), ...files(join(ROOT, "src", "app"), /\.tsx$/)];
    expect(components.flatMap((p) => hits(p, shownText(readFileSync(p, "utf8"))))).toEqual([]);
  });
});

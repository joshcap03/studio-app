import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The Supabase secret key bypasses Row Level Security, so exactly one file may hold it: the
// worker's trigger/lib/elevated.ts, which uses it only for the worker_* functions and to open
// a session as a task's member (AGENTS.md). This fails if the key or the admin Auth API shows
// up in any other tracked or new file. Docs may name them.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ALLOWED = new Set([
  "trigger/lib/elevated.ts",
  // Checks the key is NOT in the app's (Vercel) env, and lists the worker's env; never uses it.
  "scripts/check-deploy-env.mjs",
  "src/lib/elevated-guard.test.ts",
]);

function filesMentioning(pattern: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["grep", "-l", "--untracked", "-F", "-e", pattern, "--", ".", ":!docs", ":!*.md", ":!package-lock.json"],
      { cwd: root, encoding: "utf8" },
    );
    return out.split("\n").filter(Boolean);
  } catch (e) {
    if ((e as { status?: number }).status === 1) return []; // no matches
    throw e;
  }
}

describe("the Supabase secret key", () => {
  it.each(["SUPABASE_SECRET_KEY", "auth.admin"])("%s appears only in trigger/lib/elevated.ts", (pattern) => {
    expect(filesMentioning(pattern).filter((f) => !ALLOWED.has(f))).toEqual([]);
  });

  it("is used where it's allowed", () => {
    expect(filesMentioning("SUPABASE_SECRET_KEY")).toContain("trigger/lib/elevated.ts");
    expect(filesMentioning("auth.admin")).toContain("trigger/lib/elevated.ts");
  });
});

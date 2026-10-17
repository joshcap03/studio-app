import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A background worker runs turns as a member outside any Next.js request, so the turn
// engine and tenancy must not reach next/* (which needs a request to work). This follows
// every import under src/lib, type-only ones included, from each entry point.

const src = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRIES = ["lib/chat/run.ts", "lib/tenant-core.ts", "lib/tasks/run-task.ts", "lib/tasks/schedule.ts"];

const IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/") ? join(src, specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  throw new Error(`Can't resolve ${specifier} from ${relative(src, from)}`);
}

/** Each next/* import reachable from `entry`, with the chain of files that leads to it. */
function nextImports(entry: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const visit = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    const path = [...chain, relative(src, file)];
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2];
      if (specifier === "next" || specifier.startsWith("next/")) found.push(`${path.join(" → ")} → ${specifier}`);
      const local = resolveLocal(file, specifier);
      if (local && local.startsWith(join(src, "lib"))) visit(local, path);
    }
  };
  visit(join(src, entry), []);
  return found;
}

describe("worker-safe modules", () => {
  it.each(ENTRIES)("%s reaches no next/* import", (entry) => {
    expect(nextImports(entry)).toEqual([]);
  });

  it("notices a next/* import", () => {
    // tenant.ts holds the request helpers, so the scan must flag it.
    expect(nextImports("lib/tenant.ts").length).toBeGreaterThan(0);
  });
});

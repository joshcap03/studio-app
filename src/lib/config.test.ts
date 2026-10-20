import { afterEach, describe, expect, it, vi } from "vitest";

// The parts of the server configuration that fail closed, read from a clean environment each time.

const BASE = { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", NEXT_PUBLIC_SUPABASE_ANON_KEY: "a".repeat(40), VOICE_PROVIDER: "mock" };

async function configWith(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries({ ...BASE, ...env })) vi.stubEnv(k, v);
  return (await import("./config")).getConfig();
}

afterEach(() => vi.unstubAllEnvs());

describe("VOICE_SPOKEN_APPROVALS", () => {
  it("is on unless set to something that reads as off", async () => {
    expect((await configWith({})).voice?.spokenApprovals).toBe(true);
    expect((await configWith({ VOICE_SPOKEN_APPROVALS: "" })).voice?.spokenApprovals).toBe(true);
    expect((await configWith({ VOICE_SPOKEN_APPROVALS: "on" })).voice?.spokenApprovals).toBe(true);
    for (const off of ["off", "OFF", " off ", "false", "0", "no", "disabled"]) {
      expect((await configWith({ VOICE_SPOKEN_APPROVALS: off })).voice?.spokenApprovals, off).toBe(false);
    }
  });
});

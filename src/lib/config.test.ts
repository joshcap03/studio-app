import { afterEach, describe, expect, it, vi } from "vitest";

// The parts of the server configuration that fail closed, read from a clean environment each time.

const BASE = { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", NEXT_PUBLIC_SUPABASE_ANON_KEY: "a".repeat(40), VOICE_ENABLED: "on", VOICE_PROVIDER: "mock" };

async function configWith(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries({ ...BASE, ...env })) vi.stubEnv(k, v);
  return (await import("./config")).getConfig();
}

afterEach(() => vi.unstubAllEnvs());

describe("VOICE_ENABLED", () => {
  it("keeps voice out of the app unless it's on, whatever else is set", async () => {
    expect((await configWith({ VOICE_ENABLED: "" })).voice).toBeUndefined();
    for (const off of ["off", "false", "0", "no", "of", "enabled"]) {
      expect((await configWith({ VOICE_ENABLED: off })).voice, off).toBeUndefined();
    }
    for (const on of ["on", "ON", " on ", "true", "1", "yes"]) {
      expect((await configWith({ VOICE_ENABLED: on })).voice?.provider, on).toBe("mock");
    }
  });
});

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

describe("watches", () => {
  it("are on only with connected apps, the webhook secret, and the worker's key", async () => {
    const all = { COMPOSIO_API_KEY: "ak_test", COMPOSIO_WEBHOOK_SECRET: "whsec_test", TRIGGER_SECRET_KEY: "tr_dev_test" };
    expect((await configWith(all)).watches).toEqual({ webhookSecret: "whsec_test", triggerKey: "tr_dev_test" });
    expect((await configWith({ ...all, COMPOSIO_API_KEY: "" })).watches).toBeUndefined();
    expect((await configWith({ ...all, COMPOSIO_WEBHOOK_SECRET: "" })).watches).toBeUndefined();
    expect((await configWith({ ...all, TRIGGER_SECRET_KEY: " " })).watches).toBeUndefined();
  });
});

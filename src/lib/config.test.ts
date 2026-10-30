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

describe("dictation", () => {
  it("is on wherever there's speech to text, with the rest of voice out too, unless it's off", async () => {
    const out = { VOICE_ENABLED: "", VOICE_PROVIDER: "elevenlabs" };
    expect((await configWith(out)).dictation).toBeUndefined();
    const keyed = await configWith({ ...out, ELEVENLABS_API_KEY: "xi_test" });
    expect(keyed.voice).toBeUndefined();
    expect(keyed.dictation).toMatchObject({ provider: "elevenlabs", elevenlabs: { apiKey: "xi_test" }, secondsPerDay: 1800 });
    expect((await configWith({})).dictation?.provider).toBe("mock");
    expect((await configWith({ ...out, ELEVENLABS_API_KEY: "xi_test", LIMIT_DICTATION_SECONDS_PER_DAY: "600" })).dictation?.secondsPerDay).toBe(600);
    for (const off of ["off", "OFF", "false", "0", "no", "disabled"]) {
      expect((await configWith({ ...out, ELEVENLABS_API_KEY: "xi_test", DICTATION: off })).dictation, off).toBeUndefined();
      expect((await configWith({ DICTATION: off })).dictation, off).toBeUndefined();
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

describe("LLM_*", () => {
  const model = { LLM_BASE_URL: "https://model.example.test/v1/", LLM_API_KEY: "k", LLM_MODEL: "small" };
  it("is Studio's own small model only with all three set, and the voice's fallback", async () => {
    expect((await configWith({})).llm).toBeUndefined();
    expect((await configWith({ LLM_BASE_URL: model.LLM_BASE_URL, LLM_MODEL: "small" })).llm).toBeUndefined();
    const config = await configWith({ ...model, LLM_EXTRA_BODY: '{"reasoning":{"enabled":false}}' });
    expect(config.llm).toEqual({ baseUrl: "https://model.example.test/v1", apiKey: "k", model: "small", extraBody: { reasoning: { enabled: false } } });
    // The voice front uses it when it has no model of its own, and its own otherwise.
    expect(config.voice?.llm).toEqual(config.llm);
    const own = await configWith({ ...model, VOICE_LLM_BASE_URL: "https://voice.example.test", VOICE_LLM_API_KEY: "v", VOICE_LLM_MODEL: "fast" });
    expect(own.voice?.llm).toMatchObject({ baseUrl: "https://voice.example.test", model: "fast" });
    expect(own.llm?.model).toBe("small");
  });
});

import { z } from "zod";

// Server-only configuration. Secrets are read here and nowhere else; nothing in this
// module is sent to the browser. (NEXT_PUBLIC_SUPABASE_* are public by design: the anon
// key only grants what Row Level Security allows a signed-in user.)

const bool = (fallback: boolean) =>
  z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === "true"));

const jsonRecord = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (!v) return undefined;
    try {
      return JSON.parse(v) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "must be valid JSON" });
      return z.NEVER;
    }
  });

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),

  AGENT_PROVIDER: z.enum(["mock", "langflow"]).default("mock"),
  AGENT_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  MOCK_STREAMING: bool(true),

  LANGFLOW_BASE_URL: z.url().optional(),
  LANGFLOW_API_KEY: z.string().optional(),
  LANGFLOW_FLOW_ID: z.string().optional(),
  LANGFLOW_STREAM: bool(true),
  LANGFLOW_END_USER_HEADER: z.string().optional(),
  LANGFLOW_TWEAKS: jsonRecord,
  // Workspaces allowed to use a live agent: comma-separated workspace ids, or "*" for all.
  // Unset means none (fail closed) — for flows that aren't tenant-aware yet.
  AGENT_LIVE_WORKSPACES: z.string().optional(),

  COMPOSIO_API_KEY: z.string().optional(),
  COMPOSIO_TOOLKITS: jsonRecord,
  // Watches (docs/watches.md): the secret Composio signs trigger webhooks with, and the
  // Trigger.dev key the webhook route hands each event to the worker with. Both or neither.
  COMPOSIO_WEBHOOK_SECRET: z.string().optional(),
  TRIGGER_SECRET_KEY: z.string().optional(),

  SUPERMEMORY_API_KEY: z.string().optional(),
  SUPERMEMORY_BASE_URL: z.url().default("https://api.supermemory.ai"),

  // The agent's LangSmith tracing. With a key, members' reply ratings are attached to the
  // run's trace as feedback. Unset means ratings stay in the app only.
  LANGSMITH_API_KEY: z.string().optional(),
  LANGSMITH_ENDPOINT: z.url().default("https://api.smith.langchain.com"),

  LIMIT_RUNS_PER_MINUTE: z.coerce.number().int().positive().default(10),
  LIMIT_RUNS_PER_WORKSPACE_PER_DAY: z.coerce.number().int().positive().default(200),
  // Replies running at once per person, across all their agents; task runs are counted apart.
  LIMIT_CONCURRENT_RUNS: z.coerce.number().int().positive().default(5),
  // Task runs (scheduled or "Run now") per workspace per day, counted apart from chat.
  LIMIT_TASK_RUNS_PER_WORKSPACE_PER_DAY: z.coerce.number().int().positive().default(50),
  // Agent runs per day across every workspace. Unset means no service-wide cap.
  LIMIT_RUNS_SERVICE_PER_DAY: z.coerce.number().int().positive().optional(),

  // Web Push (VAPID) keys for notifications on members' devices. `npx web-push
  // generate-vapid-keys` makes a pair. Unset means notifications are off.
  VAPID_PUBLIC_KEY: z.string().optional(),
  /** The same Browserbase project the flow's Studio Browser uses; turns on watching the agent's browser on a call. */
  BROWSERBASE_API_KEY: z.string().optional(),
  /** Seals saved logins and cards (src/lib/secrets): 32 random bytes, base64. Unset means nothing can be saved. */
  CREDENTIALS_KEY: z
    .string()
    .optional()
    .refine((v) => !v?.trim() || Buffer.from(v.trim(), "base64").length === 32, "must be 32 bytes, base64"),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().regex(/^(mailto:|https:)/, "must be a mailto: or https: URL").optional(),

  // Accounts that see preview features: comma-separated sign-in emails. Unset means nobody.
  PREVIEW_FEATURE_EMAILS: z.string().optional(),
  // Accounts that see only the voice preview (the Setup Call), on top of the ones above.
  PREVIEW_VOICE_EMAILS: z.string().optional(),

  // Voice (calls, the mic, voice notes, voice choices) is out of the app unless this is "on":
  // members see and hear none of it, and the routes behind it refuse. The rest of the settings
  // below only count once it's on.
  VOICE_ENABLED: z.string().optional(),
  // Voice calls (preview). "elevenlabs" needs every ELEVENLABS_* and VOICE_* value below; "mock"
  // is a labeled stand-in for QA (typed speech, captions, no audio). Unset means calls are off,
  // unless the ElevenLabs keys are set.
  VOICE_PROVIDER: z.enum(["mock", "elevenlabs"]).optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_AGENT_ID: z.string().optional(),
  // Signs the voice context sealed into each call, and keys the names clips go by in the voice
  // ledger (see src/lib/voice/seal.ts). 32+ characters.
  VOICE_SEAL_SECRET: z.string().min(32).optional(),
  // What ElevenLabs sends the voice front (/api/voice/llm) as its custom-LLM API key.
  VOICE_LLM_SECRET: z.string().min(24).optional(),
  // The OpenAI-compatible model the voice front talks with. Unset under the mock means the mock's
  // own scripted replies.
  VOICE_LLM_BASE_URL: z.url().optional(),
  VOICE_LLM_API_KEY: z.string().optional(),
  VOICE_LLM_MODEL: z.string().optional(),
  // Extra fields for the voice model's requests, as JSON, e.g. {"reasoning":{"enabled":false}} to
  // skip thinking on OpenRouter (a voice should answer fast).
  VOICE_LLM_EXTRA_BODY: jsonRecord,
  // Voice time per person per day (UTC), calls and speech outside them (voice previews, voice
  // notes) together, and the longest one call may run, in seconds.
  LIMIT_VOICE_SECONDS_PER_DAY: z.coerce.number().int().min(0).default(1800),
  LIMIT_VOICE_CALL_SECONDS: z.coerce.number().int().min(60).max(7200).default(1500),
  // Spoken approvals on calls (docs/voice.md): on unless set to "off". One report that one wasn't
  // what the member said turns them off for everyone anyway, until cleared with SQL.
  VOICE_SPOKEN_APPROVALS: z.string().optional(),
});

const toolkitSchema = z.record(
  z.string().regex(/^[a-z0-9_]+$/),
  z.object({ name: z.string().min(1), authConfigId: z.string().min(1), description: z.string().optional() }),
);

export interface ToolkitConfig {
  slug: string;
  name: string;
  authConfigId: string;
  description?: string;
}

export interface AppConfig {
  supabase: { url: string; anonKey: string };
  agent: {
    provider: "mock" | "langflow";
    idleTimeoutMs: number;
    mockStreaming: boolean;
    /** Workspace ids allowed to use a live provider; "all" when set to "*". */
    liveWorkspaces: "all" | Set<string>;
    langflow?: {
      baseUrl: string;
      apiKey: string;
      flowId: string;
      stream: boolean;
      endUserHeader?: string;
      tweaks?: unknown;
    };
  };
  composio?: { apiKey: string; toolkits: ToolkitConfig[] };
  /** Events from members' watches. Unset means the webhook refuses them (watches never fire). */
  watches?: { webhookSecret: string; triggerKey: string };
  /** Long-term memory. Unset means the agent remembers nothing between conversations. */
  supermemory?: { apiKey: string; baseUrl: string };
  /** Where reply ratings go as trace feedback. Unset means they aren't sent anywhere. */
  langsmith?: { apiKey: string; endpoint: string };
  /** Push notifications. Unset means members can't turn them on. */
  push?: { publicKey: string; privateKey: string; subject: string };
  /** The agent's browser: watching it, filling a login or card into it, taking it over. Unset means it's off. */
  browser?: { apiKey: string };
  /** The key saved logins and cards are sealed with. Unset means members can fill but not save. */
  credentials?: { key: Buffer };
  limits: {
    runsPerMinute: number;
    runsPerWorkspacePerDay: number;
    concurrentRuns: number;
    runsServicePerDay?: number;
    taskRunsPerWorkspacePerDay: number;
  };
  /** Lowercased sign-in emails allowed to see preview features (see src/lib/flags.ts). */
  previewEmails: Set<string>;
  /** Lowercased sign-in emails allowed to see only the voice preview. */
  previewVoiceEmails: Set<string>;
  /** Voice calls. Unset means they're off. */
  voice?: VoiceConfig;
}

export interface VoiceConfig {
  provider: "mock" | "elevenlabs";
  elevenlabs?: { apiKey: string; agentId: string };
  /** Signs each call's sealed context and keys clip names. Under the mock without one, a per-process random key. */
  sealSecret: string;
  /** The custom-LLM key ElevenLabs sends the voice front. */
  llmSecret?: string;
  /** The model the voice front talks with; unset under the mock means its scripted replies. */
  llm?: { baseUrl: string; apiKey: string; model: string; extraBody?: Record<string, unknown> };
  limits: { secondsPerDay: number; callSeconds: number };
  /** Whether a call may approve a request by voice at all (VOICE_SPOKEN_APPROVALS). */
  spokenApprovals: boolean;
}

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(normalize(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid server configuration. Check .env.local (see .env.example):\n${issues}`);
  }
  const env = parsed.data;

  let langflow: AppConfig["agent"]["langflow"];
  if (env.AGENT_PROVIDER === "langflow") {
    if (!env.LANGFLOW_BASE_URL || !env.LANGFLOW_API_KEY || !env.LANGFLOW_FLOW_ID) {
      throw new Error("AGENT_PROVIDER=langflow needs LANGFLOW_BASE_URL, LANGFLOW_API_KEY, and LANGFLOW_FLOW_ID.");
    }
    langflow = {
      baseUrl: env.LANGFLOW_BASE_URL,
      apiKey: env.LANGFLOW_API_KEY,
      flowId: env.LANGFLOW_FLOW_ID,
      stream: env.LANGFLOW_STREAM,
      endUserHeader: env.LANGFLOW_END_USER_HEADER,
      tweaks: env.LANGFLOW_TWEAKS,
    };
  }

  let composio: AppConfig["composio"];
  if (env.COMPOSIO_API_KEY) {
    const toolkits = toolkitSchema.safeParse(env.COMPOSIO_TOOLKITS ?? {});
    if (!toolkits.success) throw new Error("COMPOSIO_TOOLKITS must map toolkit slugs to { name, authConfigId }.");
    composio = {
      apiKey: env.COMPOSIO_API_KEY,
      toolkits: Object.entries(toolkits.data).map(([slug, t]) => ({ slug, ...t })),
    };
  }

  const voice = voiceConfig(env);

  cached = {
    supabase: { url: env.NEXT_PUBLIC_SUPABASE_URL, anonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY },
    agent: {
      provider: env.AGENT_PROVIDER,
      idleTimeoutMs: env.AGENT_IDLE_TIMEOUT_MS,
      mockStreaming: env.MOCK_STREAMING,
      liveWorkspaces:
        env.AGENT_LIVE_WORKSPACES?.trim() === "*"
          ? "all"
          : new Set((env.AGENT_LIVE_WORKSPACES ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
      langflow,
    },
    composio,
    watches:
      composio && env.COMPOSIO_WEBHOOK_SECRET?.trim() && env.TRIGGER_SECRET_KEY?.trim()
        ? { webhookSecret: env.COMPOSIO_WEBHOOK_SECRET.trim(), triggerKey: env.TRIGGER_SECRET_KEY.trim() }
        : undefined,
    supermemory: env.SUPERMEMORY_API_KEY ? { apiKey: env.SUPERMEMORY_API_KEY, baseUrl: env.SUPERMEMORY_BASE_URL } : undefined,
    langsmith: env.LANGSMITH_API_KEY ? { apiKey: env.LANGSMITH_API_KEY, endpoint: env.LANGSMITH_ENDPOINT } : undefined,
    browser: env.BROWSERBASE_API_KEY?.trim() ? { apiKey: env.BROWSERBASE_API_KEY.trim() } : undefined,
    credentials: env.CREDENTIALS_KEY?.trim() ? { key: Buffer.from(env.CREDENTIALS_KEY.trim(), "base64") } : undefined,
    push:
      env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
        ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT ?? "mailto:notifications@example.com" }
        : undefined,
    limits: {
      runsPerMinute: env.LIMIT_RUNS_PER_MINUTE,
      runsPerWorkspacePerDay: env.LIMIT_RUNS_PER_WORKSPACE_PER_DAY,
      concurrentRuns: env.LIMIT_CONCURRENT_RUNS,
      runsServicePerDay: env.LIMIT_RUNS_SERVICE_PER_DAY,
      taskRunsPerWorkspacePerDay: env.LIMIT_TASK_RUNS_PER_WORKSPACE_PER_DAY,
    },
    previewEmails: emails(env.PREVIEW_FEATURE_EMAILS),
    previewVoiceEmails: emails(env.PREVIEW_VOICE_EMAILS),
    voice,
  };
  return cached;
}

function emails(list: string | undefined): Set<string> {
  return new Set((list ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function voiceConfig(env: z.infer<typeof schema>): VoiceConfig | undefined {
  // Only something that reads as on (on, true, 1, yes) brings voice back, so a mistyped switch leaves it out.
  if (!/^(on|true|1|yes)$/i.test(env.VOICE_ENABLED?.trim() ?? "")) return undefined;
  const provider = env.VOICE_PROVIDER ?? (env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID ? "elevenlabs" : undefined);
  if (!provider) return undefined;
  const llm =
    env.VOICE_LLM_BASE_URL && env.VOICE_LLM_API_KEY && env.VOICE_LLM_MODEL
      ? {
          baseUrl: env.VOICE_LLM_BASE_URL.replace(/\/+$/, ""),
          apiKey: env.VOICE_LLM_API_KEY,
          model: env.VOICE_LLM_MODEL,
          ...(isPlainObject(env.VOICE_LLM_EXTRA_BODY) ? { extraBody: env.VOICE_LLM_EXTRA_BODY } : {}),
        }
      : undefined;
  const limits = { secondsPerDay: env.LIMIT_VOICE_SECONDS_PER_DAY, callSeconds: env.LIMIT_VOICE_CALL_SECONDS };
  // Anything that reads as "off" turns it off, so a mistyped switch fails closed.
  const spokenApprovals = !/^(off|false|0|no|disabled?)$/i.test(env.VOICE_SPOKEN_APPROVALS?.trim() ?? "");
  if (provider === "elevenlabs") {
    if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_AGENT_ID || !env.VOICE_SEAL_SECRET || !env.VOICE_LLM_SECRET || !llm) {
      // A preview feature: half set up, calls stay off rather than taking the app down.
      console.error(
        "[config] Voice calls are off: ElevenLabs needs ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, VOICE_SEAL_SECRET, VOICE_LLM_SECRET, VOICE_LLM_BASE_URL, VOICE_LLM_API_KEY, and VOICE_LLM_MODEL.",
      );
      return undefined;
    }
    return {
      provider,
      elevenlabs: { apiKey: env.ELEVENLABS_API_KEY, agentId: env.ELEVENLABS_AGENT_ID },
      sealSecret: env.VOICE_SEAL_SECRET,
      llmSecret: env.VOICE_LLM_SECRET,
      llm,
      limits,
      spokenApprovals,
    };
  }
  return { provider, sealSecret: env.VOICE_SEAL_SECRET ?? processSecret(), llm, limits, spokenApprovals };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A random signing key for this process, for the mock voice without a configured one. */
function processSecret(): string {
  const g = globalThis as unknown as { __voiceSealSecret?: string };
  return (g.__voiceSealSecret ??= Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""));
}

/** Treat empty strings as unset so `KEY=` in an env file means "use the default". */
function normalize(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) out[k] = v === "" ? undefined : v;
  return out;
}

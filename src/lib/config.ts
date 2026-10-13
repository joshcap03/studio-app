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
  AGENT_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
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

  LIMIT_RUNS_PER_MINUTE: z.coerce.number().int().positive().default(10),
  LIMIT_RUNS_PER_WORKSPACE_PER_DAY: z.coerce.number().int().positive().default(200),
  LIMIT_CONCURRENT_RUNS: z.coerce.number().int().positive().default(2),
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
  limits: { runsPerMinute: number; runsPerWorkspacePerDay: number; concurrentRuns: number };
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
    limits: {
      runsPerMinute: env.LIMIT_RUNS_PER_MINUTE,
      runsPerWorkspacePerDay: env.LIMIT_RUNS_PER_WORKSPACE_PER_DAY,
      concurrentRuns: env.LIMIT_CONCURRENT_RUNS,
    },
  };
  return cached;
}

/** Treat empty strings as unset so `KEY=` in an env file means "use the default". */
function normalize(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) out[k] = v === "" ? undefined : v;
  return out;
}

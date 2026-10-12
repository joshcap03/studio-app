import { z } from "zod";

// Server-only configuration. Every secret is read here and nowhere else; nothing in this
// module is ever sent to the browser.

const boolString = z
  .enum(["true", "false"])
  .optional()
  .transform((v) => v !== "false");

const schema = z.object({
  APP_PASSWORD: z.string().min(12, "APP_PASSWORD must be at least 12 characters"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  AGENT_ADAPTER: z.enum(["mock", "http"]).default("mock"),
  AGENT_API_URL: z.url().optional(),
  AGENT_API_KEY: z.string().optional(),
  AGENT_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  MOCK_STREAMING: boolString,
  DATABASE_PATH: z.string().default(".data/workspace.db"),
});

export interface AppConfig {
  appPassword: string;
  sessionSecret: string;
  agent: {
    adapter: "mock" | "http";
    apiUrl?: string;
    apiKey?: string;
    idleTimeoutMs: number;
    mockStreaming: boolean;
  };
  databasePath: string;
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
  if (process.env.NODE_ENV === "production" && env.APP_PASSWORD.startsWith("qa-local-only")) {
    throw new Error("The QA password from `npm run qa:serve` must never be used in production.");
  }
  cached = {
    appPassword: env.APP_PASSWORD,
    sessionSecret: env.SESSION_SECRET,
    agent: {
      adapter: env.AGENT_ADAPTER,
      apiUrl: env.AGENT_API_URL,
      apiKey: env.AGENT_API_KEY,
      idleTimeoutMs: env.AGENT_IDLE_TIMEOUT_MS,
      mockStreaming: env.MOCK_STREAMING,
    },
    databasePath: env.DATABASE_PATH,
  };
  return cached;
}

/** Treat empty strings as unset so `KEY=` in an env file means "use the default". */
function normalize(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) out[k] = v === "" ? undefined : v;
  return out;
}

#!/usr/bin/env node
// Checks that the environment has what a production deploy needs (see .env.example).
// Reads process.env only and never prints a value, just pass / warn / fail per item.
//
//   vercel env pull .env.production.local --environment=production
//   npm run check:deploy-env   (loads .env.production.local if present)
//   node --env-file=.env.production.local scripts/check-deploy-env.mjs
//
// With --worker it checks the background worker's env instead (the Trigger.dev project's
// prod environment, exported to a file; docs/deploy-checklist.md, "Background worker"):
//
//   node --env-file=.env.worker.local scripts/check-deploy-env.mjs --worker
//
// The worker needs the app's agent settings (it runs the same turns) plus the Supabase secret
// key; the app must never have that key. Exits 1 if anything fails.

const WORKER = process.argv.includes("--worker");

const env = Object.fromEntries(
  Object.entries(process.env).map(([k, v]) => [k, typeof v === "string" && v.trim() === "" ? undefined : v?.trim()]),
);

const results = [];
const pass = (name, note = "") => void results.push({ level: "pass", name, note });
const warn = (name, note) => void results.push({ level: "warn", name, note });
const fail = (name, note) => void results.push({ level: "fail", name, note });

const LOCAL_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|host\.docker\.internal)$|\.(localhost|test|local|internal)$/i;

/** Checks an https, non-local URL. Returns the URL or undefined. */
function publicHttpsUrl(name) {
  const raw = env[name];
  if (!raw) return fail(name, "not set");
  let url;
  try {
    url = new URL(raw);
  } catch {
    return fail(name, "not a valid URL");
  }
  if (url.protocol !== "https:") return fail(name, "must use https");
  if (LOCAL_HOSTS.test(url.hostname)) return fail(name, "points at a local/private host");
  return url;
}

function parseJson(name) {
  try {
    return { ok: true, value: JSON.parse(env[name]) };
  } catch {
    return { ok: false };
  }
}

function positiveInt(name) {
  return /^\d+$/.test(env[name] ?? "") && Number(env[name]) > 0;
}

// --- Supabase ---
const supabaseUrl = publicHttpsUrl("NEXT_PUBLIC_SUPABASE_URL");
if (supabaseUrl) {
  if (/\.supabase\.co$/i.test(supabaseUrl.hostname)) pass("NEXT_PUBLIC_SUPABASE_URL");
  else warn("NEXT_PUBLIC_SUPABASE_URL", "https, but not a *.supabase.co host (fine for a custom domain)");
}

const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!anon) fail("NEXT_PUBLIC_SUPABASE_ANON_KEY", "not set");
else if (anon.startsWith("sb_secret_")) fail("NEXT_PUBLIC_SUPABASE_ANON_KEY", "is a SECRET key; use the anon/publishable key");
else if (anon.startsWith("sb_publishable_")) pass("NEXT_PUBLIC_SUPABASE_ANON_KEY", "publishable key");
else {
  const role = jwtRole(anon);
  if (role === "service_role") fail("NEXT_PUBLIC_SUPABASE_ANON_KEY", "is the service_role key; use the anon key");
  else if (role === "anon") pass("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon JWT");
  else if (anon.length < 20) fail("NEXT_PUBLIC_SUPABASE_ANON_KEY", "too short to be a key");
  else warn("NEXT_PUBLIC_SUPABASE_ANON_KEY", "unrecognized key format; double-check it is the anon key");
}

// --- Supabase secret key: the worker's alone (trigger/lib/elevated.ts) ---
const secret = env.SUPABASE_SECRET_KEY;
if (!WORKER) {
  if (secret) fail("SUPABASE_SECRET_KEY", "is set for the app; only the background worker may have it. Remove it from Vercel");
  if (!env.SUPABASE_ACCESS_TOKEN) fail("SUPABASE_ACCESS_TOKEN", "not set; production builds need it to apply migrations");
  else pass("SUPABASE_ACCESS_TOKEN");
} else {
  if (!secret) fail("SUPABASE_SECRET_KEY", "not set; the worker needs it to find due tasks and sign in as their members");
  else if (secret.startsWith("sb_secret_") || jwtRole(secret) === "service_role") pass("SUPABASE_SECRET_KEY");
  else fail("SUPABASE_SECRET_KEY", "isn't a secret key (sb_secret_…) or a service_role key");
  if (env.SUPABASE_ACCESS_TOKEN) warn("SUPABASE_ACCESS_TOKEN", "set, but the worker doesn't need it; remove it");
  if (!env.PREVIEW_FEATURE_EMAILS) warn("PREVIEW_FEATURE_EMAILS", "not set; tasks are a preview feature, so the worker will skip every run");
  if (env.TRIGGER_SECRET_KEY) pass("TRIGGER_SECRET_KEY", "set (Trigger.dev provides it in its own environments)");
}

function jwtRole(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).role;
  } catch {
    return undefined;
  }
}

// --- Agent provider ---
if (env.AGENT_PROVIDER === "langflow") pass("AGENT_PROVIDER", "langflow");
else fail("AGENT_PROVIDER", env.AGENT_PROVIDER ? "must be langflow in production (mock is for development)" : "not set (defaults to mock)");

// --- Langflow ---
if (publicHttpsUrl("LANGFLOW_BASE_URL")) pass("LANGFLOW_BASE_URL");
if (env.LANGFLOW_API_KEY) pass("LANGFLOW_API_KEY");
else fail("LANGFLOW_API_KEY", "not set");
if (env.LANGFLOW_FLOW_ID) pass("LANGFLOW_FLOW_ID");
else fail("LANGFLOW_FLOW_ID", "not set");

if (!env.LANGFLOW_TWEAKS) {
  fail("LANGFLOW_TWEAKS", "not set; use the template printed by langflow/install.py");
} else {
  const tweaks = parseJson("LANGFLOW_TWEAKS");
  if (!tweaks.ok || typeof tweaks.value !== "object" || tweaks.value === null || Array.isArray(tweaks.value)) {
    fail("LANGFLOW_TWEAKS", "not a JSON object");
  } else {
    const nodes = Object.entries(tweaks.value);
    const memberApps = nodes.filter(([id]) => id.startsWith("MemberApps"));
    if (memberApps.length === 0) fail("LANGFLOW_TWEAKS", "no MemberApps node; run langflow/install.py on the flow");
    else if (!memberApps.every(([, v]) => v?.member_id === "{{composio_user_id}}"))
      fail("LANGFLOW_TWEAKS", 'MemberApps member_id must be exactly "{{composio_user_id}}"');
    else pass("LANGFLOW_TWEAKS", "MemberApps scoped to the member");

    const values = nodes.flatMap(([, v]) => (v && typeof v === "object" ? Object.values(v) : []));
    if (!values.includes("{{system_context}}")) warn("LANGFLOW_TWEAKS", "no {{system_context}}; the agent won't get workspace context");
    if (!values.includes("{{files}}")) warn("LANGFLOW_TWEAKS", "no {{files}}; file attachments are turned off");
  }
}

// --- Composio ---
const composioKey = env.COMPOSIO_API_KEY;
if (!composioKey) fail("COMPOSIO_API_KEY", "not set (the flow's Member Apps node needs it)");
else if (!composioKey.startsWith("ak_")) fail("COMPOSIO_API_KEY", "must be a project key (ak_…)");
else pass("COMPOSIO_API_KEY");

if (!env.COMPOSIO_TOOLKITS) pass("COMPOSIO_TOOLKITS", "not set: apps are dynamic (connected in chat, Composio-managed auth)");
else {
  const toolkits = parseJson("COMPOSIO_TOOLKITS");
  const ok =
    toolkits.ok &&
    toolkits.value &&
    typeof toolkits.value === "object" &&
    !Array.isArray(toolkits.value) &&
    Object.entries(toolkits.value).every(
      ([slug, t]) => /^[a-z0-9_]+$/.test(slug) && typeof t?.name === "string" && typeof t?.authConfigId === "string",
    );
  if (ok) pass("COMPOSIO_TOOLKITS", `${Object.keys(toolkits.value).length} app(s)`);
  else fail("COMPOSIO_TOOLKITS", "must be JSON mapping toolkit slugs to { name, authConfigId }");
}

// --- Memory ---
if (env.SUPERMEMORY_API_KEY) pass("SUPERMEMORY_API_KEY");
else warn("SUPERMEMORY_API_KEY", "not set; the agent won't remember anything between conversations");

// --- Push notifications ---
if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
  pass("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY");
  if (/^(mailto:|https:)/.test(env.VAPID_SUBJECT ?? "")) pass("VAPID_SUBJECT");
  else warn("VAPID_SUBJECT", "not a mailto: or https: URL; push services may reject notifications");
} else if (env.VAPID_PUBLIC_KEY || env.VAPID_PRIVATE_KEY) {
  fail("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY", "only one of the pair is set");
} else {
  warn("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY", "not set; members can't turn on notifications (npx web-push generate-vapid-keys)");
}

// --- Access and limits ---
if (!env.AGENT_LIVE_WORKSPACES) fail("AGENT_LIVE_WORKSPACES", 'not set; no workspace can use the live agent (use "*" once the flow is installed)');
else if (env.AGENT_LIVE_WORKSPACES === "*") pass("AGENT_LIVE_WORKSPACES", "all workspaces");
else warn("AGENT_LIVE_WORKSPACES", "a list of workspace ids; new sign-ups won't get the live agent");

if (!env.LIMIT_RUNS_SERVICE_PER_DAY) warn("LIMIT_RUNS_SERVICE_PER_DAY", "not set; no service-wide cap on agent runs (model bill)");
else if (positiveInt("LIMIT_RUNS_SERVICE_PER_DAY")) pass("LIMIT_RUNS_SERVICE_PER_DAY");
else fail("LIMIT_RUNS_SERVICE_PER_DAY", "must be a positive integer");

for (const name of ["LIMIT_RUNS_PER_MINUTE", "LIMIT_RUNS_PER_WORKSPACE_PER_DAY", "LIMIT_CONCURRENT_RUNS", "LIMIT_TASK_RUNS_PER_WORKSPACE_PER_DAY", "AGENT_IDLE_TIMEOUT_MS"]) {
  if (env[name] && !positiveInt(name)) fail(name, "must be a positive integer");
}
for (const name of ["LANGFLOW_STREAM", "MOCK_STREAMING"]) {
  if (env[name] && !["true", "false"].includes(env[name])) fail(name, 'must be "true" or "false"');
}

// --- Report ---
const label = { pass: "PASS", warn: "WARN", fail: "FAIL" };
for (const r of results) console.log(`${label[r.level]}  ${r.name}${r.note ? `: ${r.note}` : ""}`);
const failed = results.filter((r) => r.level === "fail").length;
const warned = results.filter((r) => r.level === "warn").length;
console.log(`\n${WORKER ? "Worker" : "App"}: ${failed} failed, ${warned} warning(s).`);
process.exit(failed ? 1 : 0);

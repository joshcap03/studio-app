import { defineConfig } from "@trigger.dev/sdk";

// The background worker that starts members' scheduled tasks (trigger/). It signs in as each
// task's member and asks the app to run the task, so it needs only NEXT_PUBLIC_SUPABASE_URL,
// NEXT_PUBLIC_SUPABASE_ANON_KEY, the Supabase secret key (trigger/lib/elevated.ts) and APP_URL,
// set in the Trigger.dev project (docs/deploy-checklist.md), not here.

export default defineConfig({
  // The project's ref (proj_…), from the Trigger.dev dashboard. Not a secret.
  project: process.env.TRIGGER_PROJECT_REF ?? "",
  runtime: "node-22",
  dirs: ["./trigger"],
  tsconfig: "./tsconfig.json",
  // Each run waits for the app to finish the turn (at most its 300s function limit).
  maxDuration: 600,
  retries: { enabledInDev: false, default: { maxAttempts: 1 } },
});

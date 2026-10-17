import { defineConfig } from "@trigger.dev/sdk";

// The background worker that runs members' scheduled tasks (trigger/). It runs turns with
// the same code as the app (src/lib), as each task's member under RLS; see trigger/lib/elevated.ts
// for the one place it holds more than that. Env vars are set in the Trigger.dev project
// (docs/deploy-checklist.md), not here.

export default defineConfig({
  // The project's ref (proj_…), from the Trigger.dev dashboard. Not a secret.
  project: process.env.TRIGGER_PROJECT_REF ?? "",
  runtime: "node-22",
  dirs: ["./trigger"],
  tsconfig: "./tsconfig.json",
  // A run is one agent turn; the turn engine's own idle timeout (5 min by default) ends quiet ones.
  maxDuration: 1800,
  retries: { enabledInDev: false, default: { maxAttempts: 1 } },
});

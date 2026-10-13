import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests: require the local Supabase stack (`supabase start`) and, for the app
// API tests, the QA server (`npm run qa:serve`). Run with `npm run test:integration`.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});

#!/usr/bin/env node
// Applies supabase/migrations to the production database before a production build, so a
// deploy never serves code whose schema isn't there yet. A failed migration fails the build.
//
// Runs only when VERCEL_ENV=production; preview and local builds skip it. Needs
// SUPABASE_ACCESS_TOKEN (a Supabase personal access token) and NEXT_PUBLIC_SUPABASE_URL,
// which names the project. Keep migrations backward-compatible: the previous deployment
// keeps serving against the new schema until this build goes live.

import { execFileSync } from "node:child_process";

const SUPABASE_CLI = "supabase@2.121.0";

if (process.env.VERCEL_ENV !== "production") {
  console.log("migrate-production: not a production build, skipping");
  process.exit(0);
}

const token = process.env.SUPABASE_ACCESS_TOKEN?.trim();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
if (!token) fail("SUPABASE_ACCESS_TOKEN is not set");
if (!url) fail("NEXT_PUBLIC_SUPABASE_URL is not set");

const ref = /^([a-z0-9]{20})\.supabase\.co$/.exec(new URL(url).hostname)?.[1];
if (!ref) fail("NEXT_PUBLIC_SUPABASE_URL is not a Supabase Cloud project URL");

supabase("link", "--project-ref", ref);
supabase("db", "push", "--linked", "--yes");

function supabase(...args) {
  execFileSync("npx", ["--yes", SUPABASE_CLI, ...args], {
    stdio: "inherit",
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: token },
  });
}

function fail(message) {
  console.error(`migrate-production: ${message}`);
  process.exit(1);
}

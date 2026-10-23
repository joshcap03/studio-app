#!/usr/bin/env node
// Points the Composio project's webhook at Studio, where members' watch events arrive
// (docs/watches.md). One per project: this creates it, or updates the existing one. Run it from
// your own terminal, once per deployment:
//
//   COMPOSIO_API_KEY=ak_…  APP_URL=https://<your app>  node scripts/composio-webhook.mjs
//
// Composio returns the webhook's signing secret only when it creates the subscription; then this
// prints it once, for COMPOSIO_WEBHOOK_SECRET in Vercel. Nothing else it prints is a secret.
// --dry-run says what it would set without calling Composio.

import { Composio } from "@composio/core";

const dry = process.argv.includes("--dry-run");
const key = process.env.COMPOSIO_API_KEY?.trim();
const app = process.env.APP_URL?.trim().replace(/\/+$/, "");

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!app || !/^https:\/\//.test(app)) fail("Set APP_URL to the app's https address.");
if (!dry && !key?.startsWith("ak_")) fail("Set COMPOSIO_API_KEY to the Composio project key (ak_…).");

const webhookUrl = `${app}/api/watches/composio`;
if (dry) {
  console.log(`Would point the project's webhook at ${webhookUrl} (V3 trigger events).`);
  process.exit(0);
}

const composio = new Composio({ apiKey: key, allowTracking: false });
const subscription = await composio.triggers.setWebhookSubscription({ webhookUrl, version: "V3" });
console.log(`Webhook ${subscription.id} → ${subscription.webhookUrl} (${subscription.version}; ${subscription.enabledEvents.join(", ")})`);
if (subscription.secret) {
  console.log("\nSet in Vercel (production), then redeploy:\nCOMPOSIO_WEBHOOK_SECRET=" + subscription.secret);
} else {
  console.log("\nThe subscription already existed, so Composio didn't send its secret again. Keep the COMPOSIO_WEBHOOK_SECRET you have, or rotate it in Composio's dashboard.");
}

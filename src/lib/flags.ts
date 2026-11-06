import { getConfig } from "@/lib/config";
import type { Session } from "@/lib/tenant-core";

// Preview features ship to everyone's build but only switch on for allowlisted accounts.
// The check uses the email of the verified session user, never anything from a request.

/**
 * "home": Home across agents, the router, and the "On Home" flag's UI (src/lib/home.ts).
 * "studio": the agent's workbench in Studio mode, "/studio" (src/components/studio), where its parts
 * are edited beside a live Try pane, with their history.
 */
export type PreviewFeature = "brain" | "why" | "voice" | "companion" | "watches" | "home" | "studio";

/** On for accounts in PREVIEW_FEATURE_EMAILS (every preview), and for voice, PREVIEW_VOICE_EMAILS too. */
export function previewEnabled(session: Pick<Session, "email">, feature: PreviewFeature): boolean {
  const email = session.email?.trim().toLowerCase();
  if (!email) return false;
  const config = getConfig();
  return config.previewEmails.has(email) || (feature === "voice" && config.previewVoiceEmails.has(email));
}

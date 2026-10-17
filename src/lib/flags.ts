import { getConfig } from "@/lib/config";
import type { Session } from "@/lib/tenant-core";

// Preview features ship to everyone's build but only switch on for allowlisted accounts.
// The check uses the email of the verified session user, never anything from a request.

export type PreviewFeature = "brain" | "why";

export function previewEnabled(session: Pick<Session, "email">, _feature: PreviewFeature): boolean {
  const email = session.email?.trim().toLowerCase();
  return Boolean(email) && getConfig().previewEmails.has(email!);
}

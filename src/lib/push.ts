import webpush from "web-push";
import { getConfig } from "@/lib/config";
import type { Session } from "@/lib/tenant-core";
import type { ChatMessage, ConversationSummary, RunReport } from "@/lib/types";

// Notifications on the devices where a member turned them on (Web Push). Subscriptions are
// read and pruned with the member's own session, so RLS keeps everyone's devices apart.

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushNotification {
  title: string;
  body: string;
  /** Path the notification opens. */
  url: string;
  /** Replaces an earlier notification with the same tag (one per conversation). */
  tag: string;
}

export function pushEnabled(): boolean {
  return Boolean(getConfig().push);
}

export function pushPublicKey(): string | null {
  return getConfig().push?.publicKey ?? null;
}

export async function saveSubscription(session: Session, sub: PushSubscriptionInput, userAgent: string | null): Promise<void> {
  const { error } = await session.db.from("push_subscriptions").upsert(
    { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, user_agent: userAgent?.slice(0, 300) ?? null },
    { onConflict: "user_id,endpoint" },
  );
  if (error) throw error;
}

export async function removeSubscription(session: Session, endpoint: string): Promise<void> {
  const { error } = await session.db.from("push_subscriptions").delete().eq("endpoint", endpoint);
  if (error) throw error;
}

const EXCERPT = 140;

/** Plain text from a reply's markdown, for a lock-screen line. */
export function excerpt(markdown: string, max = EXCERPT): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * What to tell the member about a run that ended while they weren't watching, or null when
 * there's nothing to say (they stopped it themselves). `from` is the agent's own name, once it
 * has one (with voice, the name its calls go by), so a member with several agents can tell
 * which one it is.
 */
export function notificationFor(
  message: ChatMessage,
  conversation: ConversationSummary,
  report?: RunReport | null,
  from?: string | null,
): PushNotification | null {
  const url = `/c/${conversation.id}`;
  const tag = `conversation:${conversation.id}`;
  const title = conversation.title || "Studio";
  const by = (text: string) => (from ? `${from}: ${text}` : text);
  switch (message.status) {
    case "complete":
      // A task's run that found nothing new stays quiet; one that needs the member says so.
      if (report?.outcome === "nothing_new") return null;
      if (report?.outcome === "needs_you") return { title: by("Needs you"), body: excerpt(report.summary || message.content) || title, url, tag };
      return { title: by(title), body: excerpt(report?.summary || message.content) || "Studio finished.", url, tag };
    case "awaiting": {
      const pending = message.approvals?.find((a) => a.status === "pending");
      return { title: by("Needs your OK"), body: excerpt(pending?.summary ?? title), url, tag };
    }
    case "error":
    case "interrupted":
      return { title: by("Couldn't finish"), body: title, url, tag };
    default:
      return null;
  }
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Sends a notification to each of the member's devices. Devices whose subscription has
 * expired or been revoked are removed. Never throws.
 */
export async function notify(session: Session, notification: PushNotification): Promise<void> {
  const push = getConfig().push;
  if (!push) return;
  try {
    const { data, error } = await session.db.from("push_subscriptions").select("id, endpoint, p256dh, auth").returns<SubscriptionRow[]>();
    if (error) throw error;
    if (!data?.length) return;
    const payload = JSON.stringify(notification);
    const gone: string[] = [];
    await Promise.all(
      data.map(async (sub) => {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
            vapidDetails: { subject: push.subject, publicKey: push.publicKey, privateKey: push.privateKey },
            TTL: 60 * 60 * 24,
            urgency: "high",
            topic: notification.tag.replace(/^conversation:/, "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
          });
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) gone.push(sub.id);
          else console.error("[push] send failed", status ?? (e as Error).message);
        }
      }),
    );
    if (gone.length) await session.db.from("push_subscriptions").delete().in("id", gone);
  } catch (e) {
    console.error("[push] notify failed", e);
  }
}

import { Composio } from "@composio/core";
import { getConfig } from "@/lib/config";
import type { ConnectionsState, ToolkitConnection } from "@/lib/types";

// Connected apps through Composio. Each person has their own opaque Composio user id
// (accounts.composio_user_id), and every call here is keyed by the *caller's* id, taken from
// their authenticated session. Connections are therefore private to one person and shared by
// all of their agents; nothing here can list or touch anyone else's accounts.
//
// The agent uses the same Composio project, and receives the caller's Composio user id on
// every run, so its tools act only through the caller's own connections.

let client: Composio | undefined;

function composio(): Composio | null {
  const config = getConfig().composio;
  if (!config) return null;
  return (client ??= new Composio({ apiKey: config.apiKey }));
}

const STATUS: Record<string, ToolkitConnection["status"]> = {
  ACTIVE: "connected",
  INITIATED: "pending",
  INITIALIZING: "pending",
};

// Offered when COMPOSIO_TOOLKITS pins nothing, so members always have something to connect
// in onboarding and settings. These connect with Composio-managed auth, like apps in chat.
const DEFAULT_APPS: { slug: string; name: string; description: string; authConfigId?: string }[] = [
  { slug: "gmail", name: "Gmail", description: "Triage your inbox and draft replies" },
  { slug: "googlecalendar", name: "Google Calendar", description: "See your schedule and book meetings" },
  { slug: "googlesheets", name: "Google Sheets", description: "Pull numbers and build reports" },
  { slug: "googledrive", name: "Google Drive", description: "Find and read your files" },
  { slug: "slack", name: "Slack", description: "Catch up on channels and post updates" },
  { slug: "notion", name: "Notion", description: "Search your docs and keep them current" },
];

/**
 * The caller's connections: the offered apps, then any toolkits in `suggested` (Composio
 * slugs the workspace's template recommends), then anything else they connected.
 */
export async function listConnections(composioUserId: string, suggested: string[] = []): Promise<ConnectionsState> {
  const config = getConfig().composio;
  const sdk = composio();
  if (!config || !sdk) return { configured: false, toolkits: [] };

  const accounts = await sdk.connectedAccounts.list({ userIds: [composioUserId] });
  type Offered = { slug: string; name: string; description?: string; authConfigId?: string };
  const base: Offered[] = config.toolkits.length > 0 ? config.toolkits : DEFAULT_APPS;
  // Suggested apps outside the offered list connect through the tool-router path below,
  // like apps connected in chat. Apps without Composio-managed auth (API-key apps such as
  // Apollo or Hunter) get a Composio-hosted form there that takes the member's key, so the
  // key goes to Composio and never through Studio.
  const extra = [...new Set(suggested)].filter((slug) => !base.some((t) => t.slug === slug)).map((slug): Offered => ({ slug, name: slug }));
  const apps = [...base, ...extra];
  const offered = apps.map<ToolkitConnection>((t) => {
    // A pinned auth config must match; a default app counts however it was connected.
    const matches = accounts.items.filter(
      (a) => a.toolkit.slug === t.slug && (!t.authConfigId || a.authConfig.id === t.authConfigId),
    );
    const best = matches.find((a) => a.status === "ACTIVE") ?? matches.find((a) => STATUS[a.status] === "pending");
    return {
      slug: t.slug,
      name: t.name,
      description: t.description,
      status: best ? (STATUS[best.status] ?? "disconnected") : "disconnected",
      connectionId: best?.id,
    };
  });
  await Promise.all(
    offered.map(async (t, i) => {
      const info = await toolkitInfo(sdk, t.slug);
      t.logo = info.logo;
      if (i >= base.length) t.name = info.name;
    }),
  );
  // Apps are dynamic: the agent can connect any app in chat, so also list what this member
  // connected that isn't in the offered list. Default apps connect through the tool-router
  // path in createConnectLink, since they aren't in config.toolkits.
  const listed = new Set(offered.map((t) => t.slug));
  const others = new Map<string, ToolkitConnection>();
  for (const a of accounts.items) {
    const status = STATUS[a.status];
    if (!status || listed.has(a.toolkit.slug)) continue;
    const prev = others.get(a.toolkit.slug);
    if (prev?.status === "connected") continue;
    others.set(a.toolkit.slug, { slug: a.toolkit.slug, name: a.toolkit.slug, status, connectionId: a.id });
  }
  await Promise.all([...others.values()].map(async (t) => Object.assign(t, await toolkitInfo(sdk, t.slug))));
  return { configured: true, toolkits: [...offered, ...[...others.values()].sort((x, y) => x.name.localeCompare(y.name))] };
}

/** Starts an OAuth (or other) connection for the caller and returns where to send them. */
export async function createConnectLink(composioUserId: string, toolkitSlug: string, callbackUrl: string): Promise<string> {
  const config = getConfig().composio;
  const sdk = composio();
  if (!config || !sdk) throw Object.assign(new Error("Connected apps aren't set up for this deployment."), { status: 501 });
  const toolkit = config.toolkits.find((t) => t.slug === toolkitSlug);
  // Apps outside the offered list connect the way the agent connects them in chat: through
  // this member's tool-router session, with Composio-managed auth.
  const request = toolkit
    ? await sdk.connectedAccounts.link(composioUserId, toolkit.authConfigId, { callbackUrl })
    : await (await sdk.create(composioUserId)).authorize(toolkitSlug, { callbackUrl }).catch((error: unknown) => {
        throw Object.assign(new Error("Unknown app."), { status: 404, cause: error });
      });
  if (!request.redirectUrl) throw new Error("Composio did not return a connection link.");
  return request.redirectUrl;
}

/** Removes the caller's connections to a toolkit. Only their own accounts are listed. */
export async function disconnect(composioUserId: string, toolkitSlug: string): Promise<boolean> {
  const sdk = composio();
  if (!sdk) return false;
  const accounts = await sdk.connectedAccounts.list({ userIds: [composioUserId] });
  const owned = accounts.items.filter((a) => a.toolkit.slug === toolkitSlug);
  for (const account of owned) await sdk.connectedAccounts.delete(account.id);
  return owned.length > 0;
}

// --- Watches (docs/watches.md): Composio trigger instances, one per watch, created under the
// caller's own Composio user id on their own connected account.

/** The caller's active connected account for a toolkit, or null when they haven't connected it. */
async function activeAccount(sdk: Composio, composioUserId: string, toolkit: string): Promise<string | null> {
  const accounts = await sdk.connectedAccounts.list({ userIds: [composioUserId] });
  return accounts.items.find((a) => a.toolkit.slug === toolkit && a.status === "ACTIVE")?.id ?? null;
}

/** Whether a trigger instance is on one of the caller's connected accounts (enabled or not). */
async function ownsTrigger(sdk: Composio, composioUserId: string, triggerId: string): Promise<boolean> {
  const accounts = await sdk.connectedAccounts.list({ userIds: [composioUserId] });
  const ids = accounts.items.map((a) => a.id);
  if (ids.length === 0) return false;
  const found = await sdk.triggers.listActive({ triggerIds: [triggerId], connectedAccountIds: ids, showDisabled: true });
  return found.items.some((t) => t.id === triggerId);
}

/**
 * Starts watching `slug` on the caller's connected `toolkit` and returns Composio's trigger id.
 * Throws 409 when they haven't connected it, 501 when connected apps aren't set up.
 */
export async function startTrigger(composioUserId: string, toolkit: string, slug: string, config: Record<string, unknown>): Promise<string> {
  const sdk = composio();
  if (!sdk) throw Object.assign(new Error("Connected apps aren't set up for this deployment."), { status: 501 });
  const connectedAccountId = await activeAccount(sdk, composioUserId, toolkit);
  if (!connectedAccountId) throw Object.assign(new Error(`Connect ${appName(toolkit)} first.`), { status: 409 });
  const { triggerId } = await sdk.triggers.create(composioUserId, slug, { connectedAccountId, triggerConfig: config }).catch((error: unknown) => {
    throw Object.assign(new Error(`${appName(toolkit)} wouldn't start that watch. Check its settings and try again.`), { status: 400, cause: error });
  });
  return triggerId;
}

/** Turns one of the caller's triggers on or off. False when it isn't theirs (or is gone). */
export async function setTriggerEnabled(composioUserId: string, triggerId: string, enabled: boolean): Promise<boolean> {
  const sdk = composio();
  if (!sdk || !(await ownsTrigger(sdk, composioUserId, triggerId))) return false;
  await (enabled ? sdk.triggers.enable(triggerId) : sdk.triggers.disable(triggerId));
  return true;
}

/** Deletes one of the caller's triggers. False when it isn't theirs (or is already gone). */
export async function deleteTrigger(composioUserId: string, triggerId: string): Promise<boolean> {
  const sdk = composio();
  if (!sdk || !(await ownsTrigger(sdk, composioUserId, triggerId))) return false;
  await sdk.triggers.delete(triggerId);
  return true;
}

/** One trigger event, as Composio signed it. */
export interface TriggerEvent {
  /** The delivery's webhook-id: the same on every retry of this event. */
  eventId: string;
  triggerId: string;
  /** Whose trigger it is, as Composio signed it. */
  composioUserId: string;
  /** The app, from the trigger's slug (GMAIL_NEW_GMAIL_MESSAGE → gmail). */
  toolkit: string;
  triggerSlug: string;
  data: Record<string, unknown>;
}

/**
 * Verifies a webhook from Composio and reads its trigger event. Throws when the signature is
 * wrong, stale (over five minutes), or missing; resolves null for a signed event that isn't a
 * trigger's (Composio's other notices), which is nothing to do.
 */
export async function parseTriggerEvent(request: Request, secret: string): Promise<TriggerEvent | null> {
  const sdk = composio();
  if (!sdk) throw Object.assign(new Error("Connected apps aren't set up for this deployment."), { status: 501 });
  const eventId = request.headers.get("webhook-id") ?? "";
  const { payload } = await sdk.triggers.parse(request, { verifySecret: secret, tolerance: 300 });
  if (!payload.userId || payload.toolkitSlug === "COMPOSIO" || !eventId) return null;
  return {
    eventId,
    triggerId: payload.metadata.id,
    composioUserId: payload.userId,
    toolkit: payload.toolkitSlug.toLowerCase(),
    triggerSlug: payload.triggerSlug,
    data: payload.payload ?? {},
  };
}

/** An app's display name without calling Composio: the offered list's, else from its slug. */
export function appName(toolkit: string): string {
  const offered = getConfig().composio?.toolkits.find((t) => t.slug === toolkit) ?? DEFAULT_APPS.find((t) => t.slug === toolkit);
  return offered?.name ?? toolkit.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const text = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
// "Dana Lee <dana@acme.com>" → "Dana Lee"; a bare address stays.
const personName = (from: string): string => from.replace(/\s*<[^>]*>\s*$/, "").replace(/^"(.*)"$/, "$1").trim() || from;

/**
 * One line for what happened, at most 200 characters: the sender and subject for an email, the
 * title for anything with one, else that something happened in the app. Read from the event's
 * own fields, which differ by trigger; nothing is guessed beyond them.
 */
export function triggerEventSummary(toolkit: string, triggerSlug: string, data: Record<string, unknown>): string {
  const app = appName(toolkit);
  const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 199)}…` : s);
  const from = text(data.sender) || text(data.from);
  const subject = text(data.subject) || text(isRecord(data.preview) ? data.preview.subject : undefined);
  if (/MESSAGE|EMAIL|MAIL/.test(triggerSlug) && (from || subject)) {
    return clip(from ? `New email from ${personName(from)}${subject ? `: ${subject}` : ""}` : `New email: ${subject}`);
  }
  const title = text(data.summary) || text(data.title) || text(data.name) || subject || text(data.text);
  return clip(title ? `New in ${app}: ${title}` : `Something new in ${app}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const toolkitInfos = new Map<string, { name: string; logo?: string }>();

/** Composio's display name and logo for an app ("googlecalendar" → "Google Calendar"). */
async function toolkitInfo(sdk: Composio, slug: string): Promise<{ name: string; logo?: string }> {
  const known = toolkitInfos.get(slug);
  if (known) return known;
  const toolkit = await sdk.toolkits.get(slug).catch(() => null);
  if (!toolkit) return { name: slug.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) };
  // Only https logos reach the browser.
  const logo = toolkit.meta?.logo?.startsWith("https://") ? toolkit.meta.logo : undefined;
  const info = { name: toolkit.name, logo };
  toolkitInfos.set(slug, info);
  return info;
}

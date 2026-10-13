import { Composio } from "@composio/core";
import { getConfig } from "@/lib/config";
import type { ConnectionsState, ToolkitConnection } from "@/lib/types";

// Connected apps through Composio. Each workspace member has their own opaque Composio user
// id (workspace_members.composio_user_id), and every call here is keyed by the *caller's*
// id, taken from their authenticated session. Connections are therefore private to one
// member of one workspace; nothing here can list or touch another member's accounts.
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

export async function listConnections(composioUserId: string): Promise<ConnectionsState> {
  const config = getConfig().composio;
  const sdk = composio();
  if (!config || !sdk) return { configured: false, toolkits: [] };

  const accounts = await sdk.connectedAccounts.list({ userIds: [composioUserId] });
  const offered = config.toolkits.map<ToolkitConnection>((t) => {
    const matches = accounts.items.filter((a) => a.toolkit.slug === t.slug && a.authConfig.id === t.authConfigId);
    const best = matches.find((a) => a.status === "ACTIVE") ?? matches.find((a) => STATUS[a.status] === "pending");
    return {
      slug: t.slug,
      name: t.name,
      description: t.description,
      status: best ? (STATUS[best.status] ?? "disconnected") : "disconnected",
      connectionId: best?.id,
    };
  });
  // Apps are dynamic: the agent can connect any app in chat, so also list what this member
  // connected that isn't in the offered list.
  const listed = new Set(offered.map((t) => t.slug));
  const others = new Map<string, ToolkitConnection>();
  for (const a of accounts.items) {
    const status = STATUS[a.status];
    if (!status || listed.has(a.toolkit.slug)) continue;
    const prev = others.get(a.toolkit.slug);
    if (prev?.status === "connected") continue;
    others.set(a.toolkit.slug, { slug: a.toolkit.slug, name: a.toolkit.slug, status, connectionId: a.id });
  }
  await Promise.all([...others.values()].map(async (t) => (t.name = await appName(sdk, t.slug))));
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

const appNames = new Map<string, string>();

/** Composio's display name for an app connected in chat ("googlecalendar" → "Google Calendar"). */
async function appName(sdk: Composio, slug: string): Promise<string> {
  const known = appNames.get(slug);
  if (known) return known;
  const name = await sdk.toolkits
    .get(slug)
    .then((t) => t.name)
    .catch(() => null);
  if (!name) return slug.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  appNames.set(slug, name);
  return name;
}

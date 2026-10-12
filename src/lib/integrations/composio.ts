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
  const toolkits = config.toolkits.map<ToolkitConnection>((t) => {
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
  return { configured: true, toolkits };
}

/** Starts an OAuth (or other) connection for the caller and returns where to send them. */
export async function createConnectLink(composioUserId: string, toolkitSlug: string, callbackUrl: string): Promise<string> {
  const config = getConfig().composio;
  const sdk = composio();
  if (!config || !sdk) throw Object.assign(new Error("Connected apps aren't set up for this deployment."), { status: 501 });
  const toolkit = config.toolkits.find((t) => t.slug === toolkitSlug);
  if (!toolkit) throw Object.assign(new Error("Unknown app."), { status: 404 });
  const request = await sdk.connectedAccounts.link(composioUserId, toolkit.authConfigId, { callbackUrl });
  if (!request.redirectUrl) throw new Error("Composio did not return a connection link.");
  return request.redirectUrl;
}

/** Removes the caller's connection to a toolkit, after confirming it is theirs. */
export async function disconnect(composioUserId: string, toolkitSlug: string): Promise<boolean> {
  const config = getConfig().composio;
  const sdk = composio();
  if (!config || !sdk) return false;
  const toolkit = config.toolkits.find((t) => t.slug === toolkitSlug);
  if (!toolkit) return false;
  const accounts = await sdk.connectedAccounts.list({ userIds: [composioUserId] });
  const owned = accounts.items.filter((a) => a.toolkit.slug === toolkit.slug && a.authConfig.id === toolkit.authConfigId);
  for (const account of owned) await sdk.connectedAccounts.delete(account.id);
  return owned.length > 0;
}

// The agent this tab shows. The active-agent cookie is the last one picked in any tab, so a
// tab sends its own with each request: switching agents in another tab (Settings opened from a
// call, say) must not move this tab's messages, calls, or edits to a different agent. The server
// honors it only if the member belongs to that agent (authorizeTenant).

/** The request header naming the tab's agent. Shared with the server's tenant.ts. */
export const AGENT_HEADER = "x-studio-agent";

let shown: string | null = null;

/** Called by each page with the agent it was rendered for, before anything asks the API. */
export function showAgent(id: string) {
  if (typeof window !== "undefined") shown = id;
}

/** Headers for a request to the app's own API, naming this tab's agent once a page has said it. */
export function agentHeaders(): Record<string, string> {
  return shown ? { [AGENT_HEADER]: shown } : {};
}

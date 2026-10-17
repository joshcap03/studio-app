import { getConfig } from "@/lib/config";
import type { AgentStatus } from "@/lib/types";
import { createLangflowAdapter } from "./langflow";
import { createMockAdapter } from "./mock";
import type { AgentAdapter } from "./types";

// Provider registry. Adding a provider (LangGraph, Deep Agents, …) means adding an adapter
// file and one case here; nothing else in the app changes.

let adapter: AgentAdapter | undefined;

export function getAgentAdapter(): AgentAdapter {
  if (adapter) return adapter;
  const { agent } = getConfig();
  switch (agent.provider) {
    case "langflow":
      adapter = createLangflowAdapter(agent.langflow!);
      break;
    case "mock":
      adapter = createMockAdapter({ streaming: agent.mockStreaming });
      break;
  }
  return adapter;
}

/**
 * Whether this workspace may use the configured agent. A live provider is gated by
 * AGENT_LIVE_WORKSPACES so a flow that isn't tenant-aware yet (shared tool connections or
 * memory) is only reachable by the workspaces it was built for. The mock is always allowed.
 */
export function agentEnabledFor(workspaceId: string): boolean {
  if (!getAgentAdapter().live) return true;
  const allowed = getConfig().agent.liveWorkspaces;
  return allowed === "all" || allowed.has(workspaceId);
}

/** What the browser is told about the backend. Never includes URLs or credentials. */
export function getAgentStatus(workspaceId: string): AgentStatus {
  const a = getAgentAdapter();
  const attachments = a.capabilities.attachments;
  if (!a.live) return { mode: "mock", label: a.label, attachments };
  if (!agentEnabledFor(workspaceId)) return { mode: "unavailable", label: "Agent not enabled yet", attachments: false };
  return { mode: "live", label: a.label, attachments };
}

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

/** What the browser is told about the backend. Never includes URLs or credentials. */
export function getAgentStatus(): AgentStatus {
  const a = getAgentAdapter();
  return { mode: a.live ? "live" : "mock", label: a.label };
}

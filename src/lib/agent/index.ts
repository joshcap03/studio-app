import { getConfig } from "@/lib/config";
import type { AgentStatus } from "@/lib/types";
import { createHttpAgentAdapter } from "./http";
import { createMockAdapter } from "./mock";
import type { AgentAdapter } from "./types";

let adapter: AgentAdapter | undefined;

/** The configured agent adapter (AGENT_ADAPTER=mock | http). */
export function getAgentAdapter(): AgentAdapter {
  if (adapter) return adapter;
  const { agent } = getConfig();
  adapter =
    agent.adapter === "http"
      ? createHttpAgentAdapter({ apiUrl: agent.apiUrl, apiKey: agent.apiKey })
      : createMockAdapter({ streaming: agent.mockStreaming });
  return adapter;
}

/** What the browser is told about the backend. Never includes URLs or credentials. */
export function getAgentStatus(): AgentStatus {
  const a = getAgentAdapter();
  return { mode: a.live ? "live" : "mock", label: a.label };
}

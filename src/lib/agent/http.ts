import { AgentError, type AgentAdapter, type AgentEvent, type AgentRunInput } from "./types";

// Adapter for the real agent backend, reached over HTTP. Backend-agnostic: whatever
// framework the agent is built with, this file is the only place that knows its protocol.
//
// NOT IMPLEMENTED YET: the API contract (endpoints, auth, payloads, streaming format, and
// thread-id behavior) has not been provided. Nothing here guesses at it. Selecting this
// adapter fails every run with a clear message until it is implemented.
//
// To implement, keep this shape and translate the backend's protocol into AgentEvents:
//
//   async *run({ threadId, message, history, signal }) {
//     const res = await fetch(new URL("<run endpoint>", baseUrl), {
//       method: "POST",
//       headers: { <auth header built from apiKey>, "Content-Type": "application/json" },
//       body: JSON.stringify(<request payload>),
//       signal,
//     });
//     if (!res.ok) throw new AgentError("<user-safe message>", { retryable: res.status >= 500 });
//     yield { type: "thread", threadId: <id from the response> };
//     for await (const event of <parse the stream>) {
//       // token chunk      -> { type: "text-delta", text }
//       // tool start/end   -> { type: "activity", id, label, status: "running" | "done" | "failed" }
//       // created file     -> { type: "artifact", artifact: { id, kind, title, url, ... } }
//       // whole reply      -> { type: "message", text }   (non-streaming fallback)
//     }
//   }
//
// Credentials stay here, on the server. They are never forwarded to the browser.

export interface HttpAgentConfig {
  apiUrl?: string;
  apiKey?: string;
}

export function createHttpAgentAdapter(config: HttpAgentConfig): AgentAdapter {
  return {
    id: "http",
    live: true,
    label: "Agent connected",
    async *run(_input: AgentRunInput): AsyncIterable<AgentEvent> {
      if (!config.apiUrl) {
        throw new AgentError("The agent isn't connected yet: AGENT_API_URL is not set.", { retryable: false });
      }
      throw new AgentError(
        "The agent connection isn't finished yet: the HTTP agent adapter still needs the API contract.",
        { retryable: false },
      );
    },
  };
}

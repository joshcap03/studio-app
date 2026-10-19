import { describe, expect, it } from "vitest";
import { createLangflowAdapter, type LangflowConfig } from "@/lib/agent/langflow";
import type { AgentEvent, AgentTenantContext } from "@/lib/agent/types";
import { libraryItemArtifact } from "@/lib/chat/turn";
import { replyOf } from "./setup-harness";

// Filing a link in the Library (file_link) on a live flow with a real model (LANGFLOW_TEST_*
// env; point it at a test flow, never the live one). When the member asks to keep a link, the
// agent files that exact link with a name and the member sees it as a step; a link they only
// mention is not filed. Made-up members and links only.

const DEFAULT_TWEAKS = {
  "WorkspaceContext-studio": { workspace_context: "{{system_context}}" },
  "MemberApps-studio": { member_id: "{{composio_user_id}}", toolkits: "{{composio_toolkits}}" },
};
const enabled = Boolean(process.env.LANGFLOW_TEST_BASE_URL && process.env.LANGFLOW_TEST_API_KEY && process.env.LANGFLOW_TEST_FLOW_ID);

const tenant = (): AgentTenantContext => ({
  workspaceId: crypto.randomUUID(),
  workspaceName: "Small business",
  userId: crypto.randomUUID(),
  composioUserId: `eval_${crypto.randomUUID()}`,
  account: { name: "Dana Okafor", about: "Runs a two-person ceramics studio." },
  composioToolkits: {},
  profile: "Help Dana run the studio: pricing, orders, and wholesale accounts.",
  agentInstructions: "",
  memories: [],
  task: null,
  tracker: [],
  setup: null,
  notes: [],
  agentFiles: [],
  guardrail: null,
  self: { name: null, manner: null },
});

async function run(message: string) {
  const config: LangflowConfig = {
    baseUrl: process.env.LANGFLOW_TEST_BASE_URL!,
    apiKey: process.env.LANGFLOW_TEST_API_KEY!,
    flowId: process.env.LANGFLOW_TEST_FLOW_ID!,
    stream: true,
    tweaks: process.env.LANGFLOW_TEST_TWEAKS ? JSON.parse(process.env.LANGFLOW_TEST_TWEAKS) : DEFAULT_TWEAKS,
  };
  const events: AgentEvent[] = [];
  for await (const e of createLangflowAdapter(config).run({
    conversationId: crypto.randomUUID(),
    threadId: null,
    message,
    history: [],
    tenant: tenant(),
    attachments: [],
    signal: AbortSignal.timeout(180_000),
  })) {
    events.push(e);
  }
  const filed = events.flatMap((e) => (e.type === "library-item" ? [libraryItemArtifact(e.item)] : []));
  const steps = events.flatMap((e) => (e.type === "activity" && !e.hidden && e.status === "done" ? [e.label] : []));
  return { filed, steps, reply: replyOf(events) };
}

describe.skipIf(!enabled)("file_link on a live flow", () => {
  const doc = "https://docs.google.com/document/d/1qX9eval-wholesale-terms/edit";

  it("files the link the member asks to keep, with a name, as a step they see", async () => {
    const { filed, steps, reply } = await run(`Save this to my library please, it's our wholesale terms: ${doc}`);
    expect(filed).toEqual([expect.objectContaining({ url: doc, kind: "document", source: "Google Docs" })]);
    expect(filed[0]!.title.length).toBeGreaterThan(0);
    expect(steps.some((s) => /^Saved “.+” to your Library$/.test(s))).toBe(true);
    expect(reply.trim().length).toBeGreaterThan(0);
  }, 200_000);

  it("doesn't file a link the member only mentions", async () => {
    const { filed } = await run(`My supplier sent their price sheet at ${doc}. Is a 10% increase normal for clay this year?`);
    expect(filed).toEqual([]);
  }, 200_000);
});

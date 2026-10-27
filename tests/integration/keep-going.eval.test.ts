import { appendFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createLangflowAdapter, type LangflowConfig } from "@/lib/agent/langflow";
import type { AgentEvent, AgentTenantContext } from "@/lib/agent/types";
import { memberAppsId } from "./behavior-cases";
import { replyOf } from "./setup-harness";

// A job longer than one reply, on a live flow with a real model (LANGFLOW_TEST_* env; point it
// at a test flow with this branch's gateway installed, never the live one). The job is a long
// computation in the member's code sandbox, which runs through the gateway (web search doesn't,
// so its time limit never applies there), and the gateway's time for tools is cut to
// KEEP_GOING_EVAL_BUDGET seconds so the reply runs out of it. The agent should hand the rest to
// its next reply with keep_going, never ask the member to say carry on. A made-up member only;
// the sandbox comes with a member-shaped id and no connected apps.

const DEFAULT_TWEAKS = {
  "WorkspaceContext-studio": { workspace_context: "{{system_context}}" },
  "MemberApps-studio": { member_id: "{{composio_user_id}}", toolkits: "{{composio_toolkits}}" },
};
const enabled = Boolean(process.env.LANGFLOW_TEST_BASE_URL && process.env.LANGFLOW_TEST_API_KEY && process.env.LANGFLOW_TEST_FLOW_ID);
const BUDGET = Number(process.env.KEEP_GOING_EVAL_BUDGET ?? 60);

const JOB =
  "In your code sandbox, estimate pi by Monte Carlo with 2 billion random points in plain Python (no numpy), " +
  "in the foreground (no background processes), so I can compare it with my own run. Give me the estimate and " +
  "how far it is from pi.";

const ASKS_TO_CARRY_ON = /\b(tell|ask|let) me to (carry|keep|go) on\b|\bsay (carry|keep|go) on\b|\b(want|like) me to (continue|carry on|keep going)\b/i;

const tenant = (): AgentTenantContext => ({
  workspaceId: crypto.randomUUID(),
  workspaceName: "Research",
  userId: crypto.randomUUID(),
  composioUserId: memberAppsId(),
  account: { name: "Sam Rivera", about: "Teaches a statistics course." },
  composioToolkits: {},
  profile: "Help Sam with course prep and analysis.",
  agentInstructions: "",
  memories: [],
  tracker: [],
  setup: null,
  notes: [],
  agentFiles: [],
  guardrail: null,
  self: { name: null, manner: null },
});

/** The flow's Tool Gateway node, whose run budget the eval cuts short. */
async function gatewayNode(): Promise<string> {
  const base = process.env.LANGFLOW_TEST_BASE_URL!.replace(/\/$/, "");
  const response = await fetch(`${base}/api/v1/flows/${process.env.LANGFLOW_TEST_FLOW_ID}`, {
    headers: { "x-api-key": process.env.LANGFLOW_TEST_API_KEY! },
  });
  const flow = (await response.json()) as { data: { nodes: { id: string; data: { node?: { template?: { code?: { value?: string } } } } }[] } };
  const node = flow.data.nodes.find((n) => n.data.node?.template?.code?.value?.includes("class ToolGatewayComponent"));
  if (!node) throw new Error("The flow has no Tool Gateway.");
  if (!node.data.node?.template?.code?.value?.includes("keep_going")) throw new Error("The flow's gateway has no keep_going: install this branch's.");
  return node.id;
}

describe.skipIf(!enabled)("a job longer than one reply, on a live flow", () => {
  let gateway = "";
  beforeAll(async () => {
    gateway = await gatewayNode();
  });

  it("hands the rest to its next reply instead of asking the member to say carry on", async () => {
    const config: LangflowConfig = {
      baseUrl: process.env.LANGFLOW_TEST_BASE_URL!,
      apiKey: process.env.LANGFLOW_TEST_API_KEY!,
      flowId: process.env.LANGFLOW_TEST_FLOW_ID!,
      stream: true,
      tweaks: { ...DEFAULT_TWEAKS, [gateway]: { run_budget: BUDGET } },
    };
    const events: AgentEvent[] = [];
    for await (const e of createLangflowAdapter(config).run({
      conversationId: crypto.randomUUID(),
      threadId: null,
      message: JOB,
      history: [],
      tenant: tenant(),
      attachments: [],
      signal: AbortSignal.timeout(240_000),
    })) {
      events.push(e);
    }
    const reply = replyOf(events);
    const going = events.find((e) => e.type === "keep-going");
    const ranOut = events.some((e) => e.type === "out-of-time");
    if (process.env.KEEP_GOING_EVAL_LOG) {
      const steps = events.flatMap((e) => (e.type === "activity" && e.status !== "running" ? [`${e.label} (${e.status})`] : []));
      appendFileSync(
        process.env.KEEP_GOING_EVAL_LOG,
        `\n--- keep_going: ${going ? JSON.stringify(going.remaining) : "no"}; ran out: ${ranOut}; events: ${[...new Set(events.map((e) => e.type))].join(",")} ---\nsteps: ${[...new Set(steps)].join(" | ")}\n${reply}\n`,
      );
    }
    // When the reply ran out of time, the agent said what's left with keep_going (it may also
    // split the job to fit one reply, which is fine)...
    if (ranOut) expect(going).toBeDefined();
    // ...and either way didn't put it on the member to say carry on.
    expect(reply).not.toMatch(ASKS_TO_CARRY_ON);
    expect(reply.trim().length).toBeGreaterThan(0);
  }, 300_000);
});

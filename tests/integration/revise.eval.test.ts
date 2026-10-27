import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createLangflowAdapter, type LangflowConfig } from "@/lib/agent/langflow";
import type { AgentEvent, AgentTenantContext } from "@/lib/agent/types";
import { replyOf } from "./setup-harness";

// Rewriting a task's result the way the member asks, on a live flow with a real model
// (LANGFLOW_TEST_* env; point it at a test flow, never the live one). The task's brief asks for
// a fixed set of parts on every item; after the agent writes it that way, the member asks for it
// much shorter, in a newsletter style they name. The rewrite should be in their form, a fraction of the length,
// not the brief's parts trimmed. A made-up member, company and news only.

const DEFAULT_TWEAKS = {
  "WorkspaceContext-studio": { workspace_context: "{{system_context}}" },
  "MemberApps-studio": { member_id: "{{composio_user_id}}", toolkits: "{{composio_toolkits}}" },
};
const enabled = Boolean(process.env.LANGFLOW_TEST_BASE_URL && process.env.LANGFLOW_TEST_API_KEY && process.env.LANGFLOW_TEST_FLOW_ID);

const BRIEF =
  "Sweep competitors, market and regulation, and customer voice for Fieldline's three products. Report the top 5-10 " +
  "changes, ranked by how much they matter and grouped by product. Each item: source link and date; one line on why " +
  "it matters; facts; my read labeled high/medium/low confidence; so-what; act/watch/ignore.";

const ITEMS = [
  ["Northgate opens its route data to AI assistants", "Dispatch", "Northgate now offers its route and fleet data through a connector for AI assistants and custom agents."],
  ["Carrow raises $40M for automated scheduling", "Dispatch", "Carrow says customers cut idle time 30%; only one customer has published before-and-after numbers."],
  ["Brightline ships an AI layer across invoicing", "Billing", "An assistant across invoicing, collections and payments, sold to mid-size field-service firms."],
  ["Two more billing suites add AI collections", "Billing", "Both pitch AI across collections and cash application in launches a week apart."],
  ["State regulators propose new technician licensing rules", "Workforce", "A draft rule would require license checks before a technician is dispatched to a job."],
  ["Payroll provider adds per-job pay", "Workforce", "Per-job pay calculation now ships inside a payroll app many small contractors already use."],
  ["Customers report slower payments from builders", "Billing", "A trade group's survey says builders are moving subcontractors to pay-when-paid terms."],
  ["Review sites show complaints about mobile app outages", "Dispatch", "Recent reviews of two rivals cite mobile outages during peak season."],
] as const;

// This week's items as the member collected them, so the first turn writes the brief in the
// brief's form without searching.
const NOTES = [
  "Here are this week's items; I've checked them, so don't search. Write this week's brief from them, following the task brief in full:",
  ...ITEMS.map(([title, product, facts], i) => `- ${title} (Oct ${10 + i}, ${product}): ${facts} Source: https://news.example/${i + 1}`),
].join("\n");

const tenant = (): AgentTenantContext => ({
  workspaceId: crypto.randomUUID(),
  workspaceName: "Market watch",
  userId: crypto.randomUUID(),
  composioUserId: `eval_${crypto.randomUUID()}`,
  account: { name: "Sam Rivera", about: "Product marketing lead at Fieldline, field-service software." },
  composioToolkits: {},
  profile: "Keep Sam on top of market changes that matter to Fieldline's products.",
  agentInstructions: "",
  memories: [],
  task: { title: "Weekly market brief", instructions: BRIEF, goal: "5-10 sourced market changes grouped by product", plan: [] },
  tracker: [],
  setup: null,
  notes: [],
  agentFiles: [],
  guardrail: null,
  self: { name: null, manner: null },
});

async function revise(ask: string) {
  const config: LangflowConfig = {
    baseUrl: process.env.LANGFLOW_TEST_BASE_URL!,
    apiKey: process.env.LANGFLOW_TEST_API_KEY!,
    flowId: process.env.LANGFLOW_TEST_FLOW_ID!,
    stream: true,
    tweaks: process.env.LANGFLOW_TEST_TWEAKS ? JSON.parse(process.env.LANGFLOW_TEST_TWEAKS) : DEFAULT_TWEAKS,
  };
  // Langflow keeps the conversation's own history, so both turns run in one conversation.
  const conversationId = crypto.randomUUID();
  const member = tenant();
  const turn = async (message: string) => {
    const events: AgentEvent[] = [];
    for await (const e of createLangflowAdapter(config).run({
      conversationId,
      threadId: null,
      message,
      history: [],
      tenant: member,
      attachments: [],
      signal: AbortSignal.timeout(240_000),
    })) {
      events.push(e);
    }
    return events;
  };
  const before = replyOf(await turn(NOTES));
  const events = await turn(ask);
  const reply = replyOf(events);
  if (process.env.REVISE_EVAL_LOG) {
    const steps = events.flatMap((e) => (e.type === "activity" && e.status === "done" ? [e.label] : []));
    appendFileSync(process.env.REVISE_EVAL_LOG, `\n--- ${reply.length}/${before.length} chars ---\nsteps: ${[...new Set(steps)].join(" | ")}\n${reply}\n`);
  }
  return { before, reply };
}

describe.skipIf(!enabled)("rewriting a task's result as the member asks, on a live flow", () => {
  it("makes it much shorter in the style they name, not the brief's parts trimmed", async () => {
    const { before, reply } = await revise("please make this much more concise i suggest reading an axios or morning brew newsletters as examples");
    // The first turn wrote it in the brief's form, at length.
    expect((before.match(/my read|confidence/gi) ?? []).length).toBeGreaterThanOrEqual(4);
    // A fraction of the length, still about the same news.
    expect(reply.length).toBeLessThan(before.length * 0.5);
    expect(ITEMS.filter(([title]) => reply.toLowerCase().includes(title.split(" ")[0].toLowerCase())).length).toBeGreaterThanOrEqual(4);
    // Not every item still carrying the brief's labeled parts.
    expect((reply.match(/my read|confidence\)/gi) ?? []).length).toBeLessThan(3);
    expect((reply.match(/\*\*facts:?\*\*/gi) ?? []).length).toBeLessThan(3);
  }, 500_000);
});

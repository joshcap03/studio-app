import { createLangflowAdapter } from "@/lib/agent/langflow";
import type { AgentEvent, AgentTenantContext } from "@/lib/agent/types";
import type { BehaviorCase } from "./behavior-cases";
import { readRun, type Run } from "./behavior-score";
import { testFlowConfig } from "./setup-harness";

// Runs behavior cases against the live test flow (LANGFLOW_TEST_* env): a case's earlier turns,
// then its message, in one conversation, with the context kept up between turns the way the app
// keeps it. Shared by the behavior evals and the connector evals.

export const RUN_TIMEOUT = 280_000;

/** At most `n` flows at once, across every case. */
export function slots(n: number) {
  let free = n;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (free > 0) free--;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else free++;
    }
  };
}

async function send(tenant: AgentTenantContext, conversationId: string, message: string, file?: BehaviorCase["file"]): Promise<Run> {
  const config = await testFlowConfig();
  const events: AgentEvent[] = [];
  const started = Date.now();
  try {
    for await (const e of createLangflowAdapter(config).run({
      conversationId,
      threadId: null,
      message,
      history: [],
      tenant,
      attachments: file ? [{ id: crypto.randomUUID(), name: file.name, mimeType: "text/plain", size: file.content.length, read: async () => new Blob([file.content], { type: "text/plain" }) }] : [],
      signal: AbortSignal.timeout(RUN_TIMEOUT),
    })) {
      events.push(e);
    }
    return readRun(events, Date.now() - started);
  } catch (error) {
    return readRun(events, Date.now() - started, error instanceof Error ? error.message : String(error));
  }
}

/** After a run, the context the next one gets, as the app keeps it: the plan, the tracker, and memory. */
function carry(tenant: AgentTenantContext, run: Run): void {
  if (run.plan) {
    const steps = run.plan.steps.map((s) => ({ text: s.text, status: s.status, note: null }));
    if (tenant.task) tenant.task = { ...tenant.task, plan: steps, goal: run.plan.goal ?? tenant.task.goal };
    else tenant.plan = { steps, goal: run.plan.goal ?? tenant.plan?.goal ?? null };
  }
  for (const r of run.records) {
    const rest = (tenant.tracker ?? []).filter((x) => !(x.collection === r.collection && x.key === r.key));
    tenant.tracker = [{ collection: r.collection, key: r.key, title: r.title, status: null }, ...rest];
  }
  tenant.memories = [...tenant.memories, ...run.memories.map((m) => m.content)];
}

/** One case: its earlier turns, then its message, all in one conversation, from `base` plus the case's context. */
export async function runCase(c: BehaviorCase, base: AgentTenantContext): Promise<Run> {
  const tenant: AgentTenantContext = { ...base, ...structuredClone(c.context ?? {}) };
  const conversationId = crypto.randomUUID();
  const earlier: Run[] = [];
  for (const message of c.before ?? []) {
    const run = await send(tenant, conversationId, message);
    earlier.push(run);
    if (run.error) return { ...run, earlier, error: `an earlier turn failed: ${run.error}` };
    carry(tenant, run);
  }
  return { ...(await send(tenant, conversationId, c.message, c.file)), earlier };
}

/** A run as the eval log keeps it: what the member saw, and which checks it missed. */
export function transcript(c: BehaviorCase, run: Run, index: number, checks: { name: string; test: (run: Run) => string | null }[]) {
  return {
    case: c.id,
    run: index + 1,
    ms: run.ms,
    error: run.error,
    misses: checks.flatMap((k) => {
      const saw = k.test(run);
      return saw === null ? [] : [{ check: k.name, saw }];
    }),
    earlier: run.earlier.map((e) => ({ reply: e.reply, plan: e.plan, records: e.records })),
    reports: run.reports,
    reply: run.reply,
    notes: run.notes,
    steps: run.steps.map((s) => `${s.app ?? "?"}/${s.action ?? "?"}${s.status === "failed" ? " FAILED" : ""}: ${s.label}${s.hidden ? " (hidden)" : ""}`),
    questions: run.questions,
    forms: run.forms,
    plan: run.plan,
    memories: run.memories,
    records: run.records,
    approvals: run.approvals,
  };
}

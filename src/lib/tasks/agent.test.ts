import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Store } from "@/lib/db/store";
import type { Tenant } from "@/lib/tenant-core";
import type { AgentSetup } from "@/lib/types";
import { createMemoryDb, createMemoryStore } from "@/test/memory-store";
import type { AgentTask } from "./types";

// Where the agent's plan is saved (src/lib/journey.ts): its task, the owner's setup, or the
// conversation itself. The task and setup stores are stubbed; the conversation's is in memory.

const state = vi.hoisted(() => ({ task: null as AgentTask | null, setup: null as AgentSetup | null, store: null as unknown }));

vi.mock("./index", () => ({
  getTaskForConversation: vi.fn(async () => state.task),
  updateTask: vi.fn(async (_tenant: unknown, _id: string, patch: Partial<AgentTask>) => (state.task = { ...state.task!, ...patch, updatedAt: 5 })),
}));
vi.mock("./records", () => ({ listRecords: vi.fn(async () => []), upsertRecord: vi.fn() }));
const records = await import("./records");
vi.mock("@/lib/chat/store-for", () => ({ storeFor: () => state.store }));
vi.mock("@/lib/setup-state", async (original) => ({
  ...(await original<typeof import("@/lib/setup-state")>()),
  getSetup: vi.fn(async () => state.setup),
  updateSetup: vi.fn(async (tenant: Tenant, patch: Partial<AgentSetup>) => {
    if (tenant.workspace.role !== "owner") return false;
    state.setup = { status: "in_progress", conversationId: null, plan: [], updatedAt: 0, ...state.setup, ...patch };
    return true;
  }),
}));

const { goalFor, goalFromAgent, planFromAgent, savePlanFromAgent, saveRecordFromAgent, taskContextFor } = await import("./agent");

const scope = { workspaceId: "ws-a", userId: "user-a" };
const owner = { workspace: { id: scope.workspaceId, role: "owner" }, userId: scope.userId } as Tenant;
const member = { workspace: { id: scope.workspaceId, role: "member" }, userId: scope.userId } as Tenant;
const task = (patch: Partial<AgentTask> = {}): AgentTask =>
  ({ id: "t1", title: "Job hunt", instructions: "", plan: [], goal: null, conversationId: "c-task", allowedActions: [], updatedAt: 1, ...patch }) as AgentTask;

let store: Store;
let chat: string;
beforeEach(async () => {
  state.task = null;
  state.setup = null;
  store = createMemoryStore(scope, createMemoryDb());
  state.store = store;
  chat = crypto.randomUUID();
  await store.createConversation({ id: chat, title: "Caterers" });
});

describe("planFromAgent", () => {
  it("turns the agent's steps into a stored plan, keeping ids of unchanged steps", () => {
    const previous = [{ id: "member-1", text: "Find roles", status: "todo" as const, note: null }];
    expect(
      planFromAgent(
        [
          { text: "Find roles", status: "done", note: "  12 found " },
          { text: "Tailor the top 3", status: "doing" },
          "Send outreach",
          { text: "  ", status: "todo" },
          { text: "Ask about salary", status: "nonsense" },
        ],
        previous,
      ),
    ).toEqual([
      { id: "member-1", text: "Find roles", status: "done", note: "12 found" },
      { id: "s2", text: "Tailor the top 3", status: "doing", note: null },
      { id: "s3", text: "Send outreach", status: "todo", note: null },
      { id: "s5", text: "Ask about salary", status: "todo", note: null },
    ]);
  });

  it("refuses anything that isn't a list of steps, and caps the plan's length", () => {
    expect(planFromAgent("do things")).toBeNull();
    expect(planFromAgent({ steps: [] })).toBeNull();
    expect(planFromAgent(Array.from({ length: 50 }, (_, i) => ({ text: `Step ${i}`, status: "todo" })))).toHaveLength(30);
  });
});

describe("goals", () => {
  it("takes what done looks like from the argument alone: one line, capped, without saying 'Done means' twice", () => {
    expect(goalFromAgent("  three caterers\n under $40   a head ")).toBe("three caterers under $40 a head");
    expect(goalFromAgent("Done means: three caterers")).toBe("three caterers");
    expect(goalFromAgent("done means three caterers")).toBe("three caterers");
    expect(goalFromAgent("x".repeat(300))).toHaveLength(200);
    for (const none of ["", "   ", undefined, null, 3, { goal: "x" }]) expect(goalFromAgent(none)).toBeNull();
  });

  it("keeps the current goal while the work carries on, and drops it for new work", () => {
    expect(goalFor("new goal", [{ text: "a" }], [{ text: "a" }], "old")).toBe("new goal");
    expect(goalFor(null, [{ text: "a" }, { text: "b" }], [{ text: "a" }], "old")).toBe("old");
    expect(goalFor(null, [{ text: "c" }], [{ text: "a" }], "old")).toBeNull();
    expect(goalFor(null, [{ text: "a" }], [], undefined)).toBeNull();
    // Nothing to compare with: a goal already there stays.
    expect(goalFor(null, [{ text: "a" }], [], "member goal")).toBe("member goal");
  });
});

describe("savePlanFromAgent", () => {
  it("saves a task's plan and goal on the task, keeping the goal through status updates", async () => {
    state.task = task();
    const first = await savePlanFromAgent(owner, "c-task", [{ text: "Find roles", status: "doing" }], "two roles worth applying to");
    expect(first).toEqual({ kind: "task", goal: "two roles worth applying to", steps: [{ text: "Find roles", status: "doing" }], updatedAt: 5 });
    const next = await savePlanFromAgent(owner, "c-task", [{ text: "Find roles", status: "done", note: "Found 2" }]);
    expect(next).toMatchObject({ kind: "task", goal: "two roles worth applying to", steps: [{ text: "Find roles", status: "done", note: "Found 2" }] });
    expect(state.task.plan[0].id).toBe("s1");
  });

  it("keeps a task's goal the member set through its first plan and through a plan rewritten from scratch", async () => {
    const { updateTask } = await import("./index");
    // Typed on the task page before the task ever ran.
    state.task = task({ goal: "two interviews booked", plan: [] });
    const first = await savePlanFromAgent(owner, "c-task", [{ text: "Search boards for PM roles", status: "doing" }]);
    expect(first).toMatchObject({ kind: "task", goal: "two interviews booked" });
    expect(state.task.goal).toBe("two interviews booked");
    // A later run rewords every step, and still gives no goal.
    const reworded = await savePlanFromAgent(owner, "c-task", [{ text: "Search job boards for new roles", status: "doing" }, { text: "Draft outreach", status: "todo" }]);
    expect(reworded).toMatchObject({ kind: "task", goal: "two interviews booked", steps: [{ text: "Search job boards for new roles" }, { text: "Draft outreach" }] });
    expect(state.task.goal).toBe("two interviews booked");
    // Nothing touched the goal at all; only a goal the agent gives changes it.
    expect(vi.mocked(updateTask).mock.calls.at(-1)?.[2]).not.toHaveProperty("goal");
    await savePlanFromAgent(owner, "c-task", [{ text: "Draft outreach", status: "doing" }], "three interviews booked");
    expect(state.task.goal).toBe("three interviews booked");
  });

  it("saves the owner's setup checklist and goal to the setup, shown as far as their bar", async () => {
    state.setup = { status: "in_progress", conversationId: chat, plan: [], updatedAt: 0 };
    const saved = await savePlanFromAgent(owner, chat, [
      { text: "What you're after", status: "done" },
      { text: "What success looks like", status: "doing" },
      { text: "Your apps", status: "todo" },
    ], "a setup you'd trust");
    expect(state.setup.plan.map((s) => s.text)).toEqual(["What you're after", "What success looks like", "Your apps"]);
    expect(state.setup.goal).toBe("a setup you'd trust");
    // Steps after the bar wait for it, on the rail as on the banner.
    expect(saved).toMatchObject({ kind: "setup", goal: "a setup you'd trust", steps: [{ text: "What you're after" }, { text: "What success looks like" }] });
    expect((await store.getPlan(chat))?.steps).toEqual([]);
  });

  it("saves a setup run's first plan to the setup before the conversation is recorded as the setup's", async () => {
    state.setup = { status: "done", conversationId: "older", plan: [{ text: "What you're after", status: "done" }], goal: "the old setup", updatedAt: 0 };
    const saved = await savePlanFromAgent(owner, chat, [{ text: "What you're after", status: "doing" }], undefined, { setup: true });
    expect(state.setup).toMatchObject({ conversationId: chat, plan: [{ text: "What you're after", status: "doing" }], goal: null });
    expect(saved?.kind).toBe("setup");
  });

  it("saves later work in a setup's conversation on the conversation once setup is applied or set aside", async () => {
    const checklist = [{ text: "What you're after", status: "done" as const, note: "Catering for a 60-person launch" }];
    for (const status of ["done", "skipped"] as const) {
      state.setup = { status, conversationId: chat, plan: checklist, goal: "a setup you'd trust", updatedAt: 0 };
      const saved = await savePlanFromAgent(owner, chat, [{ text: "Search caterers", status: "doing" }, { text: "Shortlist", status: "todo" }], "three caterers under $40 a head");
      expect(saved).toMatchObject({ kind: "conversation", goal: "three caterers under $40 a head", steps: [{ text: "Search caterers" }, { text: "Shortlist" }] });
      // The interview's record stays as it ended.
      expect(state.setup).toMatchObject({ status, plan: checklist, goal: "a setup you'd trust" });
      expect((await store.getPlan(chat))?.goal).toBe("three caterers under $40 a head");
      // A run started with the setup skill picks the interview up again, there or anywhere.
      expect((await savePlanFromAgent(owner, chat, [{ text: "What you're after", status: "done" }, { text: "Your bar", status: "doing" }], undefined, { setup: true }))?.kind).toBe("setup");
      expect(state.setup.plan.map((s) => s.text)).toEqual(["What you're after", "Your bar"]);
      await store.savePlan(chat, { steps: [], goal: null });
    }
  });

  it("saves any other conversation's plan on the conversation, for a member as for the owner", async () => {
    for (const tenant of [owner, member]) {
      const saved = await savePlanFromAgent(tenant, chat, [{ text: "Search caterers", status: "doing" }, { text: "Shortlist", status: "todo" }], " three caterers under $40 a head ");
      expect(saved).toMatchObject({ kind: "conversation", goal: "three caterers under $40 a head", steps: [{ text: "Search caterers", status: "doing" }, { text: "Shortlist", status: "todo" }] });
      expect((await store.getPlan(chat))?.goal).toBe("three caterers under $40 a head");
      // A status update keeps the goal; a plan with nothing in common is new work.
      expect((await savePlanFromAgent(tenant, chat, [{ text: "Search caterers", status: "done" }, { text: "Shortlist", status: "doing" }]))?.goal).toBe(
        "three caterers under $40 a head",
      );
      expect((await savePlanFromAgent(tenant, chat, [{ text: "Book a venue", status: "todo" }]))?.goal).toBeNull();
    }
    // A member's setup run has no setup to save to: it's their conversation's plan.
    expect((await savePlanFromAgent(member, chat, [{ text: "What you're after", status: "doing" }], undefined, { setup: true }))?.kind).toBe("conversation");
    expect(state.setup).toBeNull();
  });

  it("saves nothing for a plan that isn't one, or a conversation that isn't theirs", async () => {
    expect(await savePlanFromAgent(owner, chat, "do the thing", "x")).toBeNull();
    expect(await savePlanFromAgent(owner, crypto.randomUUID(), [{ text: "x", status: "todo" }])).toBeNull();
    expect((await store.getPlan(chat))?.steps).toEqual([]);
  });
});

describe("taskContextFor", () => {
  it("gives the agent its task's goal, or in another conversation its own plan for the work there", async () => {
    await store.savePlan(chat, { steps: [{ id: "s1", text: "Search caterers", status: "doing", note: null }], goal: "three caterers" });
    expect((await taskContextFor(owner, chat)).plan).toEqual({ goal: "three caterers", steps: [{ text: "Search caterers", status: "doing", note: null }] });
    state.task = task({ goal: "two roles", plan: [{ id: "s1", text: "Find roles", status: "todo" }] });
    const withTask = await taskContextFor(owner, chat);
    expect(withTask.task).toMatchObject({ title: "Job hunt", goal: "two roles" });
    expect(withTask.plan).toBeNull();
  });
});

describe("saveRecordFromAgent", () => {
  it("saves a row without the placeholders the agent filled fields with", async () => {
    const saved = await saveRecordFromAgent(owner, chat, { collection: "Roles", key: "https://jobs.example/1", status: "closed", fields: { reason: "Filled", next_step: "None", pay: "" } }, { messageId: crypto.randomUUID() });
    expect(saved).toBe("roles");
    expect(vi.mocked(records.upsertRecord).mock.lastCall?.[1]).toMatchObject({ collection: "roles", status: "closed", fields: { reason: "Filled" } });
    expect(vi.mocked(records.upsertRecord).mock.lastCall?.[1].fields).toEqual({ reason: "Filled" });
  });
});

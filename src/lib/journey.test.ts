import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tenant } from "@/lib/tenant-core";
import type { AgentTask } from "@/lib/tasks/types";
import type { AgentSetup } from "@/lib/types";
import { createMemoryDb, createMemoryStore } from "@/test/memory-store";

// Which plan a conversation's rail shows: its task's, else the owner's setup checklist while their
// interview is under way there, else the conversation's own.

const state = vi.hoisted(() => ({ task: null as AgentTask | null, setup: null as AgentSetup | null, store: null as unknown }));
vi.mock("@/lib/tasks", () => ({ getTaskForConversation: vi.fn(async () => state.task) }));
vi.mock("@/lib/chat/store-for", () => ({ storeFor: () => state.store }));
vi.mock("@/lib/setup-state", async (original) => ({
  ...(await original<typeof import("@/lib/setup-state")>()),
  getSetup: vi.fn(async () => state.setup),
}));

const { conversationJourney, journeyFor, setupJourney, taskJourney } = await import("./journey");

const scope = { workspaceId: "ws-a", userId: "user-a" };
const owner = { workspace: { id: scope.workspaceId, role: "owner" }, userId: scope.userId } as Tenant;
const member = { workspace: { id: scope.workspaceId, role: "member" }, userId: scope.userId } as Tenant;
let chat: string;

beforeEach(async () => {
  const store = createMemoryStore(scope, createMemoryDb());
  state.store = store;
  chat = crypto.randomUUID();
  await store.createConversation({ id: chat, title: "Caterers" });
  await store.savePlan(chat, { steps: [{ id: "s1", text: "Search caterers", status: "doing", note: null }], goal: "three caterers" });
  state.task = { plan: [{ id: "s1", text: "Find roles", status: "todo" }], goal: "two roles", updatedAt: 7 } as AgentTask;
  state.setup = { status: "in_progress", conversationId: chat, plan: [{ text: "What you're after", status: "doing" }], goal: "a setup you'd trust", updatedAt: 3 };
});

describe("journeyFor", () => {
  it("shows the task's plan first, then the owner's setup, then the conversation's own", async () => {
    expect(await journeyFor(owner, chat)).toEqual({ kind: "task", goal: "two roles", steps: [{ text: "Find roles", status: "todo" }], updatedAt: 7 });
    state.task = null;
    expect(await journeyFor(owner, chat)).toEqual({ kind: "setup", goal: "a setup you'd trust", steps: [{ text: "What you're after", status: "doing" }], updatedAt: 3 });
    // Only the owner has a setup; a member sees their own plan.
    expect(await journeyFor(member, chat)).toMatchObject({ kind: "conversation", goal: "three caterers", steps: [{ text: "Search caterers", status: "doing" }] });
    state.setup = { ...state.setup!, conversationId: "elsewhere" };
    expect((await journeyFor(owner, chat))?.kind).toBe("conversation");
  });

  it("shows the setup's checklist only while the interview is under way there", async () => {
    state.task = null;
    for (const status of ["done", "skipped"] as const) {
      state.setup = { ...state.setup!, status, conversationId: chat };
      // Work after setup keeps its own plan, and shows it.
      expect(await journeyFor(owner, chat)).toMatchObject({ kind: "conversation", goal: "three caterers", steps: [{ text: "Search caterers" }] });
    }
  });

  it("is null where the agent keeps no plan, or the conversation isn't theirs", async () => {
    state.task = null;
    state.setup = null;
    expect(await journeyFor(owner, crypto.randomUUID())).toBeNull();
    const empty = crypto.randomUUID();
    await (state.store as ReturnType<typeof createMemoryStore>).createConversation({ id: empty, title: "Hi" });
    expect(await journeyFor(owner, empty)).toBeNull();
  });

  it("shows nothing for a plan with no steps", () => {
    expect(taskJourney({ plan: [], goal: "x", updatedAt: 1 })).toBeNull();
    expect(setupJourney({ plan: [], goal: "x", updatedAt: 1 })).toBeNull();
    expect(conversationJourney({ steps: [], goal: "x", updatedAt: 1 })).toBeNull();
  });

  it("dates a task's plan by when the plan changed, not the task's other edits", () => {
    const plan = [{ id: "s1", text: "Find roles", status: "doing" as const }];
    expect(taskJourney({ plan, goal: null, updatedAt: 9, planUpdatedAt: 4 })?.updatedAt).toBe(4);
    expect(taskJourney({ plan, goal: null, updatedAt: 9, planUpdatedAt: null })?.updatedAt).toBe(9);
  });
});

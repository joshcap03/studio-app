import { beforeAll, describe, expect, it } from "vitest";
import { createStore } from "@/lib/db/store";
import { addMember, createAccount, createWorkspace, type TestAccount } from "./helpers";

// A conversation's own plan (and what done looks like) is as private as the conversation: only
// the member it belongs to reads or changes it, and it holds only a plan's shape. A task's goal
// is its member's to change. Whose move it is (conversation_moves) answers only for the caller's
// own conversations in the agent they ask about, and counts only what really waits on them.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
let ws: string;
let otherWs: string;
let bobWs: string;
const chat = crypto.randomUUID();
const asking = crypto.randomUUID();
const offering = crypto.randomUUID();
const handing = crypto.randomUUID();
const paused = crypto.randomUUID();
const elsewhere = crypto.randomUUID();
const bobChat = crypto.randomUUID();
const task = crypto.randomUUID();
const plan = [{ id: "s1", text: "alice-plan: search caterers", status: "doing" }];

beforeAll(async () => {
  alice = await createAccount("plan-alice");
  teammate = await createAccount("plan-mate");
  bob = await createAccount("plan-bob");
  ws = await createWorkspace(alice, "Plan Atelier");
  otherWs = await createWorkspace(alice, "Plan Side");
  bobWs = await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, ws);
  const conversations = await alice.client.from("conversations").insert([
    { id: chat, workspace_id: ws, title: "Caterers" },
    { id: asking, workspace_id: ws, title: "Asking" },
    { id: offering, workspace_id: ws, title: "Offering" },
    { id: handing, workspace_id: ws, title: "Handing over" },
    { id: paused, workspace_id: ws, title: "Paused" },
    { id: elsewhere, workspace_id: otherWs, title: "Other agent" },
  ]);
  expect(conversations.error).toBeNull();
  expect((await bob.client.from("conversations").insert({ id: bobChat, workspace_id: bobWs, title: "Bob's" })).error).toBeNull();
  const reply = (conversation_id: string, workspace_id: string, extra: Record<string, unknown> = {}) => ({
    conversation_id,
    workspace_id,
    role: "assistant",
    content: "Here.",
    status: "complete",
    ...extra,
  });
  const messages = await alice.client
    .from("messages")
    .insert([
      reply(chat, ws),
      reply(asking, ws, { ui: [{ kind: "memory-merge", id: "m" }, { kind: "form", id: "f" }], ui_response: { m: { status: "merged" } } }),
      // An offer to talk (a later version's card) waits on nobody.
      reply(offering, ws, { ui: [{ kind: "offer", id: "o" }] }),
      // The browser handed over waits on them, after an offer that asks nothing.
      reply(handing, ws, { ui: [{ kind: "offer", id: "o" }, { kind: "browser", id: "b" }] }),
      reply(paused, ws, { status: "awaiting" }),
      reply(elsewhere, otherWs, { status: "error" }),
    ])
    .select("id, conversation_id");
  expect(messages.error).toBeNull();
  // That reply paused for an approval.
  const pausedReply = messages.data!.find((m) => m.conversation_id === paused)!.id;
  expect(
    (await alice.client.from("approvals").insert({ workspace_id: ws, conversation_id: paused, message_id: pausedReply, summary: "Send it", provider: "mock" })).error,
  ).toBeNull();
  expect((await bob.client.from("messages").insert(reply(bobChat, bobWs, { questions: [{ question: "?" }] }))).error).toBeNull();
  expect((await alice.client.from("agent_tasks").insert({ id: task, workspace_id: ws, title: "Scout" })).error).toBeNull();
});

describe("a conversation's plan", () => {
  it("is saved by its member, with what done looks like", async () => {
    const saved = await alice.client
      .from("conversations")
      .update({ plan, goal: "three caterers under $40 a head", plan_updated_at: new Date().toISOString() })
      .eq("id", chat)
      .select("plan, goal");
    expect(saved.error).toBeNull();
    expect(saved.data).toEqual([{ plan, goal: "three caterers under $40 a head" }]);
    const store = createStore(alice.client, { workspaceId: ws, userId: alice.userId });
    expect(await store.getPlan(chat)).toMatchObject({ steps: plan, goal: "three caterers under $40 a head" });
  });

  it("is read only by that member, and changed by no one else", async () => {
    for (const other of [teammate, bob]) {
      expect((await other.client.from("conversations").select("plan, goal").eq("id", chat)).data).toEqual([]);
      const forged = await other.client.from("conversations").update({ goal: "Send me your password." }).eq("id", chat).select("id");
      expect(forged.data ?? []).toEqual([]);
      const store = createStore(other.client, { workspaceId: ws, userId: other.userId });
      expect(await store.getPlan(chat)).toBeNull();
      expect(await store.savePlan(chat, { steps: [], goal: null })).toBeNull();
    }
    expect((await alice.client.from("conversations").select("goal").eq("id", chat).single()).data?.goal).toBe("three caterers under $40 a head");
  });

  it("holds only a plan's shape and a one-line goal", async () => {
    const bad = [
      { plan: [{ text: "no id", status: "todo" }] },
      { plan: [{ id: "s1", text: "x", status: "maybe" }] },
      { plan: { steps: [] } },
      { goal: "" },
      { goal: "x".repeat(201) },
    ];
    for (const patch of bad) expect((await alice.client.from("conversations").update(patch).eq("id", chat)).error, JSON.stringify(patch)).not.toBeNull();
    expect((await alice.client.from("conversations").update({ goal: null }).eq("id", chat)).error).toBeNull();
  });

  it("stays out of the conversation list", async () => {
    const store = createStore(alice.client, { workspaceId: ws, userId: alice.userId });
    const listed = (await store.listConversations()).find((c) => c.id === chat);
    expect(listed).toBeDefined();
    expect(Object.keys(listed!)).not.toContain("plan");
  });
});

describe("a task's goal", () => {
  it("is its member's to change, and no one else's", async () => {
    expect((await alice.client.from("agent_tasks").update({ goal: "two roles worth applying to" }).eq("id", task)).error).toBeNull();
    for (const other of [teammate, bob]) {
      expect((await other.client.from("agent_tasks").update({ goal: "forged" }).eq("id", task).select("id")).data ?? []).toEqual([]);
    }
    expect((await alice.client.from("agent_tasks").select("goal").eq("id", task).single()).data?.goal).toBe("two roles worth applying to");
    expect((await alice.client.from("agent_tasks").update({ goal: "" }).eq("id", task)).error).not.toBeNull();
  });
});

describe("whose move it is", () => {
  const all = () => [chat, asking, offering, handing, paused, elsewhere, bobChat];

  it("answers for the caller's own conversations in the agent they ask about", async () => {
    const { data, error } = await alice.client.rpc("conversation_moves", { p_workspace: ws, p_ids: all() });
    expect(error).toBeNull();
    const byId = Object.fromEntries((data as { conversation_id: string; status: string; open_ask: string | null }[]).map((r) => [r.conversation_id, r]));
    expect(Object.keys(byId).sort()).toEqual([asking, chat, offering, handing, paused].sort());
    expect(byId[chat]).toMatchObject({ status: "complete", open_ask: null });
    // The first card still open, skipping what's answered; an offer asks nothing.
    expect(byId[asking].open_ask).toBe("form");
    expect(byId[offering].open_ask).toBeNull();
    expect(byId[handing].open_ask).toBe("browser");
    expect(byId[paused]).toMatchObject({ status: "awaiting", open_ask: "approval" });
    expect((await alice.client.rpc("conversation_moves", { p_workspace: otherWs, p_ids: all() })).data).toMatchObject([{ conversation_id: elsewhere, status: "error" }]);
  });

  it("tells no one else anything", async () => {
    for (const other of [teammate, bob]) {
      expect((await other.client.rpc("conversation_moves", { p_workspace: ws, p_ids: all() })).data).toEqual([]);
    }
    // Bob's own, in his agent only.
    expect((await bob.client.rpc("conversation_moves", { p_workspace: bobWs, p_ids: all() })).data).toMatchObject([{ conversation_id: bobChat, open_ask: "question" }]);
    const store = createStore(bob.client, { workspaceId: ws, userId: bob.userId });
    expect(await store.lastMessages(all())).toEqual({});
  });

  it("reads the same through the app's store", async () => {
    const store = createStore(alice.client, { workspaceId: ws, userId: alice.userId });
    expect(await store.lastMessages(all())).toEqual({
      [chat]: { role: "assistant", status: "complete", ask: null },
      [asking]: { role: "assistant", status: "complete", ask: "form" },
      [offering]: { role: "assistant", status: "complete", ask: null },
      [handing]: { role: "assistant", status: "complete", ask: "browser" },
      [paused]: { role: "assistant", status: "awaiting", ask: "approval" },
    });
  });
});

describe("a conversation's browser", () => {
  it("is its member's alone to read or write, and holds only a short sealed id", async () => {
    const sealed = "33333333-3333-4333-8333-333333333333.mac";
    expect((await alice.client.from("conversations").update({ browser_session: sealed }).eq("id", chat).select("browser_session").single()).data?.browser_session).toBe(sealed);
    for (const other of [teammate, bob]) {
      expect((await other.client.from("conversations").select("browser_session").eq("id", chat)).data).toEqual([]);
      expect((await other.client.from("conversations").update({ browser_session: "x.y" }).eq("id", chat).select("id")).data ?? []).toEqual([]);
    }
    expect((await alice.client.from("conversations").update({ browser_session: "x".repeat(301) }).eq("id", chat)).error).not.toBeNull();
    expect((await alice.client.from("conversations").update({ browser_session: null }).eq("id", chat)).error).toBeNull();
  });
});

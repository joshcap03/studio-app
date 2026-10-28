import { beforeAll, describe, expect, it } from "vitest";
import { createStore, type Store } from "@/lib/db/store";
import { createAccount, createWorkspace, type TestAccount } from "./helpers";

// A conversation loads a page of its newest messages, earlier pages as the member reads back,
// and only what changed while a run is followed; a turn reads every message with only what it
// needs. Each read is the member's own, under RLS: another member's session sees none of them.

let alice: TestAccount;
let bob: TestAccount;
let store: Store;
let bobStore: Store;
const conversation = crypto.randomUUID();
const ids: string[] = [];

beforeAll(async () => {
  alice = await createAccount("pages-alice");
  bob = await createAccount("pages-bob");
  const ws = await createWorkspace(alice, "Pages");
  await createWorkspace(bob, "Elsewhere");
  store = createStore(alice.client, { workspaceId: ws, userId: alice.userId });
  // Bob's session naming Alice's agent and Alice herself: RLS still decides.
  bobStore = createStore(bob.client, { workspaceId: ws, userId: alice.userId });
  await store.createConversation({ id: conversation, title: "Long one" });
  for (let i = 0; i < 7; i++) {
    const m = await store.insertMessage({
      id: crypto.randomUUID(),
      conversationId: conversation,
      role: i % 2 ? "assistant" : "user",
      content: `m${i}`,
      status: "complete",
      activity: i % 2 ? [{ id: "s", label: "Looked it up", status: "done", startedAt: 1, endedAt: 2 }] : [],
      artifacts: [],
    });
    ids.push(m.id);
  }
});

describe("message pages", () => {
  it("load the newest first, then the pages before, until there are none", async () => {
    const newest = await store.pageMessages(conversation, { limit: 3 });
    expect(newest.messages.map((m) => m.content)).toEqual(["m4", "m5", "m6"]);
    expect(newest.earlier).toBe(true);
    const before = await store.pageMessages(conversation, { limit: 3, before: newest.messages[0].id });
    expect(before.messages.map((m) => m.content)).toEqual(["m1", "m2", "m3"]);
    expect(before.earlier).toBe(true);
    const first = await store.pageMessages(conversation, { limit: 3, before: before.messages[0].id });
    expect(first).toMatchObject({ messages: [{ content: "m0" }], earlier: false });
    // Full messages: a page has the steps on each reply.
    expect(newest.messages[1].activity).toHaveLength(1);
  });

  it("follow from one message on, and say when it's gone", async () => {
    const since = await store.messagesSince(conversation, ids[5]);
    expect(since?.map((m) => m.content)).toEqual(["m5", "m6"]);
    expect(await store.messagesSince(conversation, crypto.randomUUID())).toBeNull();
  });

  it("give a turn every message with only what it needs", async () => {
    const run = await store.listMessagesForRun(conversation);
    expect(run.map((m) => m.content)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6"]);
    expect(run[1]).not.toHaveProperty("activity");
    expect(run[1]).toMatchObject({ role: "assistant", status: "complete", origin: null, skill: null });
  });

  it("are never another member's", async () => {
    expect(await bobStore.pageMessages(conversation, { limit: 3 })).toEqual({ messages: [], earlier: false });
    expect(await bobStore.pageMessages(conversation, { limit: 3, before: ids[6] })).toEqual({ messages: [], earlier: false });
    expect(await bobStore.messagesSince(conversation, ids[0])).toBeNull();
    expect(await bobStore.listMessagesForRun(conversation)).toEqual([]);
    expect(await bobStore.latestMessage(conversation)).toBeNull();
  });
});

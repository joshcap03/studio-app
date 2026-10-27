import { beforeAll, describe, expect, it } from "vitest";
import { createStore } from "@/lib/db/store";
import { addMember, createAccount, createWorkspace, type TestAccount } from "./helpers";

// Stop is a flag on a streaming reply that the server running it reads, wherever the request
// landed. Only the member whose reply it is can ask for it, or see it; teammates and other
// tenants can't stop it. A reply that streams again starts without one.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
let ws: string;
const conversation = crypto.randomUUID();
const reply = crypto.randomUUID();
const done = crypto.randomUUID();

beforeAll(async () => {
  alice = await createAccount("stop-alice");
  teammate = await createAccount("stop-mate");
  bob = await createAccount("stop-bob");
  ws = await createWorkspace(alice, "Stop Atelier");
  await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, ws);
  expect((await alice.client.from("conversations").insert({ id: conversation, workspace_id: ws, title: "Working" })).error).toBeNull();
  const inserted = await alice.client.from("messages").insert([
    { id: done, conversation_id: conversation, workspace_id: ws, role: "assistant", content: "earlier", status: "complete" },
    { id: reply, conversation_id: conversation, workspace_id: ws, role: "assistant", content: "working", status: "streaming" },
  ]);
  expect(inserted.error).toBeNull();
});

describe("stopping a reply", () => {
  it("can't be asked for or seen by anyone else", async () => {
    for (const other of [teammate, bob]) {
      const update = await other.client.from("messages").update({ stop_requested_at: new Date().toISOString() }).eq("id", reply).select("id");
      expect(update.data ?? []).toEqual([]);
      expect((await other.client.from("messages").select("stop_requested_at").eq("id", reply)).data).toEqual([]);
    }
    expect(await createStore(teammate.client, { workspaceId: ws, userId: teammate.userId }).requestStop(conversation)).toBe(false);
    expect(await createStore(alice.client, { workspaceId: ws, userId: alice.userId }).stopRequested(reply)).toBe(false);
  });

  it("flags only the member's streaming reply, which the run then sees", async () => {
    const store = createStore(alice.client, { workspaceId: ws, userId: alice.userId });
    const before = (await alice.client.from("messages").select("updated_at").eq("id", reply).single()).data?.updated_at;
    expect(await store.requestStop(conversation)).toBe(true);
    expect(await store.stopRequested(reply)).toBe(true);
    expect(await store.stopRequested(done)).toBe(false);
    // Asking isn't progress: it leaves the reply's last checkpoint alone.
    expect((await alice.client.from("messages").select("updated_at").eq("id", reply).single()).data?.updated_at).toBe(before);
  });

  it("is forgotten once the reply streams again", async () => {
    const store = createStore(alice.client, { workspaceId: ws, userId: alice.userId });
    await store.updateMessage(reply, { status: "awaiting" });
    expect(await store.requestStop(conversation)).toBe(false); // nothing streaming
    await store.updateMessage(reply, { status: "streaming" });
    expect(await store.stopRequested(reply)).toBe(false);
  });
});

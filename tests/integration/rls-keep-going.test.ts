import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { createStore } from "@/lib/db/store";
import { addMember, createAccount, createWorkspace, serviceClient, type TestAccount } from "./helpers";

// A chat reply that carries a job on (keep_going) is carried on once: by the member's page, or by
// the background worker when no page is open. Each takes the reply first (continued_at), and only
// the member whose reply it is can; the worker asks worker_reply_waiting (service role only)
// whether it's still waiting before it signs in as them.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
let admin: SupabaseClient;
let ws: string;

beforeAll(async () => {
  alice = await createAccount("keep-alice");
  teammate = await createAccount("keep-mate");
  bob = await createAccount("keep-bob");
  ws = await createWorkspace(alice, "Keep Going Atelier");
  await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, ws);
  admin = await serviceClient();
});

/** One of Alice's conversations whose latest reply carries the job on. */
async function waitingReply(): Promise<{ conversation: string; reply: string }> {
  const conversation = crypto.randomUUID();
  const reply = crypto.randomUUID();
  expect((await alice.client.from("conversations").insert({ id: conversation, workspace_id: ws, title: "Tagging" })).error).toBeNull();
  const ask = await alice.client.from("messages").insert({ conversation_id: conversation, workspace_id: ws, role: "user", content: "Tag my inbox", status: "complete" });
  expect(ask.error).toBeNull();
  const answer = await alice.client
    .from("messages")
    .insert({ id: reply, conversation_id: conversation, workspace_id: ws, role: "assistant", content: "Tagged 200.", status: "complete", keep_going: "the other 400" });
  expect(answer.error).toBeNull();
  return { conversation, reply };
}

const waiting = async (r: { conversation: string; reply: string }, userId = alice.userId) => {
  const { data, error } = await admin.rpc("worker_reply_waiting", { p_reply: r.reply, p_conversation: r.conversation, p_user: userId });
  expect(error).toBeNull();
  return data as boolean;
};

describe("carrying a chat reply's job on", () => {
  it("is taken once, only by the member whose reply it is", async () => {
    const r = await waitingReply();
    for (const other of [teammate, bob]) {
      const update = await other.client.from("messages").update({ continued_at: new Date().toISOString() }).eq("id", r.reply).select("id");
      expect(update.data ?? []).toEqual([]);
    }
    expect(await createStore(teammate.client, { workspaceId: ws, userId: teammate.userId }).claimKeepGoing(r.conversation, r.reply)).toBe(false);
    expect(await waiting(r)).toBe(true);

    const store = createStore(alice.client, { workspaceId: ws, userId: alice.userId });
    const [first, second] = await Promise.all([store.claimKeepGoing(r.conversation, r.reply), store.claimKeepGoing(r.conversation, r.reply)]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await store.claimKeepGoing(r.conversation, r.reply)).toBe(false);
    // Taken, it no longer reads as carrying on, to the page or the worker.
    expect((await store.listMessages(r.conversation)).at(-1)?.keepGoing).toBeUndefined();
    expect(await waiting(r)).toBe(false);
  });

  it("is ended by the member's Stop, or by anything they send", async () => {
    const stopped = await waitingReply();
    const store = createStore(alice.client, { workspaceId: ws, userId: alice.userId });
    expect((await store.listMessages(stopped.conversation)).at(-1)?.keepGoing).toBe("the other 400");
    expect(await store.claimKeepGoing(stopped.conversation)).toBe(true);
    expect(await waiting(stopped)).toBe(false);

    const wrote = await waitingReply();
    const sent = await alice.client.from("messages").insert({ conversation_id: wrote.conversation, workspace_id: ws, role: "user", content: "Actually, just the newest", status: "complete" });
    expect(sent.error).toBeNull();
    expect(await waiting(wrote)).toBe(false);
  });

  it("is asked about by the worker only, for the reply's own member and conversation", async () => {
    const r = await waitingReply();
    expect(await waiting(r, bob.userId)).toBe(false);
    expect(await waiting({ conversation: crypto.randomUUID(), reply: r.reply })).toBe(false);
    for (const client of [alice.client, bob.client]) {
      const res = await client.rpc("worker_reply_waiting", { p_reply: r.reply, p_conversation: r.conversation, p_user: alice.userId });
      expect(res.error).toBeTruthy();
    }
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createAccount, createWorkspace, type TestAccount } from "./helpers";

// A member's rating of a reply, and why, is as private as the reply: not visible to or
// changeable by other tenants, nor by teammates in the same workspace.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
const conversation = crypto.randomUUID();
const reply = crypto.randomUUID();
const question = crypto.randomUUID();

beforeAll(async () => {
  alice = await createAccount("feedback-alice");
  teammate = await createAccount("feedback-mate");
  bob = await createAccount("feedback-bob");
  const ws = await createWorkspace(alice, "Feedback Atelier");
  await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, ws);
  expect((await alice.client.from("conversations").insert({ id: conversation, workspace_id: ws, title: "Rated" })).error).toBeNull();
  const inserted = await alice.client.from("messages").insert([
    { id: question, conversation_id: conversation, workspace_id: ws, role: "user", content: "hi", status: "complete" },
    { id: reply, conversation_id: conversation, workspace_id: ws, role: "assistant", content: "hello", status: "complete" },
  ]);
  expect(inserted.error).toBeNull();
  const rated = await alice.client
    .from("messages")
    .update({ feedback: { rating: "down", reasons: ["Too long"], note: "alice-note" } })
    .eq("id", reply);
  expect(rated.error).toBeNull();
});

describe("reply feedback", () => {
  it("is visible only to the member who gave it", async () => {
    const own = await alice.client.from("messages").select("feedback").eq("id", reply).single();
    expect(own.data?.feedback).toMatchObject({ rating: "down", note: "alice-note" });
    expect((await teammate.client.from("messages").select("feedback").eq("id", reply)).data).toEqual([]);
    expect((await bob.client.from("messages").select("feedback").eq("id", reply)).data).toEqual([]);
  });

  it("can't be changed by anyone else", async () => {
    for (const other of [teammate, bob]) {
      const update = await other.client.from("messages").update({ feedback: { rating: "up", reasons: [] } }).eq("id", reply).select("id");
      expect(update.data ?? []).toEqual([]);
    }
    const own = await alice.client.from("messages").select("feedback").eq("id", reply).single();
    expect(own.data?.feedback).toMatchObject({ rating: "down" });
  });

  it("only rates replies, with a known rating", async () => {
    expect((await alice.client.from("messages").update({ feedback: { rating: "up", reasons: [] } }).eq("id", question)).error).not.toBeNull();
    expect((await alice.client.from("messages").update({ feedback: { rating: "meh", reasons: [] } }).eq("id", reply)).error).not.toBeNull();
    expect((await alice.client.from("messages").update({ feedback: ["up"] }).eq("id", reply)).error).not.toBeNull();
  });
});

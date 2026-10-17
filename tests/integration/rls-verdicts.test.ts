import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createAccount, createWorkspace, type TestAccount } from "./helpers";

// A member's keep/pass calls are their own standard: no one else in the agent, and no other
// tenant, can read or add to them, and once made they aren't rewritten.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
let ws: string;
const conversation = crypto.randomUUID();
const reply = crypto.randomUUID();
const block = crypto.randomUUID();
const row = () => ({ workspace_id: ws, message_id: reply, block_id: block, item_id: "acme", title: "Senior Designer · Acme", verdict: "pass", reason: "Too junior" });

beforeAll(async () => {
  alice = await createAccount("verdict-alice");
  teammate = await createAccount("verdict-mate");
  bob = await createAccount("verdict-bob");
  ws = await createWorkspace(alice, "Verdict Atelier");
  await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, ws);
  expect((await alice.client.from("conversations").insert({ id: conversation, workspace_id: ws, title: "Trial run" })).error).toBeNull();
  expect((await alice.client.from("messages").insert({ id: reply, conversation_id: conversation, workspace_id: ws, role: "assistant", content: "", status: "complete" })).error).toBeNull();
  expect((await alice.client.from("agent_verdicts").insert(row())).error).toBeNull();
});

describe("agent verdicts", () => {
  it("are visible only to the member who made them", async () => {
    expect((await alice.client.from("agent_verdicts").select("title, verdict, reason").eq("message_id", reply)).data).toEqual([
      { title: "Senior Designer · Acme", verdict: "pass", reason: "Too junior" },
    ]);
    expect((await teammate.client.from("agent_verdicts").select("id").eq("message_id", reply)).data).toEqual([]);
    expect((await bob.client.from("agent_verdicts").select("id").eq("message_id", reply)).data).toEqual([]);
  });

  it("can't be added on someone else's reply or agent", async () => {
    // The teammate belongs to the agent, but the reply is alice's.
    expect((await teammate.client.from("agent_verdicts").insert({ ...row(), item_id: "mate" })).error).not.toBeNull();
    expect((await bob.client.from("agent_verdicts").insert({ ...row(), item_id: "bob" })).error).not.toBeNull();
  });

  it("aren't rewritten, and hold only keep or pass", async () => {
    const update = await alice.client.from("agent_verdicts").update({ verdict: "keep" }).eq("message_id", reply).select("id");
    expect(update.error).not.toBeNull();
    expect((await alice.client.from("agent_verdicts").insert({ ...row(), item_id: "maybe", verdict: "maybe" })).error).not.toBeNull();
  });
});

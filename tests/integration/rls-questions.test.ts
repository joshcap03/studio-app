import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createAccount, createWorkspace, type TestAccount } from "./helpers";

// The agent's questions can quote one member's records ("which of these orders?"), so they
// stay as private as the reply they belong to.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
const conversation = crypto.randomUUID();
const reply = crypto.randomUUID();

beforeAll(async () => {
  alice = await createAccount("questions-alice");
  teammate = await createAccount("questions-mate");
  bob = await createAccount("questions-bob");
  const ws = await createWorkspace(alice, "Questions Atelier");
  await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, ws);
  expect((await alice.client.from("conversations").insert({ id: conversation, workspace_id: ws, title: "Which?" })).error).toBeNull();
  const inserted = await alice.client.from("messages").insert({
    id: reply,
    conversation_id: conversation,
    workspace_id: ws,
    role: "assistant",
    content: "",
    status: "complete",
    questions: [{ question: "alice-which", options: [{ label: "a" }, { label: "b" }], multiSelect: false }],
  });
  expect(inserted.error).toBeNull();
});

describe("message questions", () => {
  it("are visible only to the member who was asked", async () => {
    const own = await alice.client.from("messages").select("questions").eq("id", reply).single();
    expect(own.data?.questions).toMatchObject([{ question: "alice-which" }]);
    expect((await teammate.client.from("messages").select("questions").eq("id", reply)).data).toEqual([]);
    expect((await bob.client.from("messages").select("questions").eq("id", reply)).data).toEqual([]);
  });

  it("can't be overwritten by anyone else", async () => {
    for (const other of [teammate, bob]) {
      const update = await other.client.from("messages").update({ questions: [{ question: "forged", options: [] }] }).eq("id", reply).select("id");
      expect(update.data ?? []).toEqual([]);
    }
    const own = await alice.client.from("messages").select("questions").eq("id", reply).single();
    expect(own.data?.questions).toMatchObject([{ question: "alice-which" }]);
  });

  it("rejects non-array questions", async () => {
    const bad = await alice.client.from("messages").update({ questions: { not: "an array" } }).eq("id", reply);
    expect(bad.error).not.toBeNull();
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createAccount, createWorkspace, type TestAccount } from "./helpers";

// Citations quote records from one member's own apps (emails, files), so they must stay as private as
// the reply it belongs to: not visible to other tenants, nor to teammates in the same workspace.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
const conversation = crypto.randomUUID();
const reply = crypto.randomUUID();

beforeAll(async () => {
  alice = await createAccount("citations-alice");
  teammate = await createAccount("citations-mate");
  bob = await createAccount("citations-bob");
  const ws = await createWorkspace(alice, "Citations Atelier");
  await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, ws);
  expect((await alice.client.from("conversations").insert({ id: conversation, workspace_id: ws, title: "Why?" })).error).toBeNull();
  const inserted = await alice.client.from("messages").insert({
    id: reply,
    conversation_id: conversation,
    workspace_id: ws,
    role: "assistant",
    content: "",
    status: "complete",
    citations: [{ n: 1, url: "https://mail.example/1", quote: "alice-quote", quoteVerified: true }],
  });
  expect(inserted.error).toBeNull();
});

describe("message citations", () => {
  it("are visible only to the member whose reply cites them", async () => {
    const own = await alice.client.from("messages").select("citations").eq("id", reply).single();
    expect(own.data?.citations).toMatchObject([{ quote: "alice-quote" }]);
    expect((await teammate.client.from("messages").select("citations").eq("id", reply)).data).toEqual([]);
    expect((await bob.client.from("messages").select("citations").eq("id", reply)).data).toEqual([]);
  });

  it("can't be overwritten by anyone else", async () => {
    for (const other of [teammate, bob]) {
      const update = await other.client.from("messages").update({ citations: [{ n: 1, url: "https://x.example", quote: "forged", quoteVerified: true }] }).eq("id", reply).select("id");
      expect(update.data ?? []).toEqual([]);
    }
    const own = await alice.client.from("messages").select("citations").eq("id", reply).single();
    expect(own.data?.citations).toMatchObject([{ quote: "alice-quote" }]);
  });

  it("rejects citations that aren't a list", async () => {
    const bad = await alice.client.from("messages").update({ citations: { not: "a list" } }).eq("id", reply);
    expect(bad.error).not.toBeNull();
  });
});

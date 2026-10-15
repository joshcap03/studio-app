import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createAccount, createWorkspace, type TestAccount } from "./helpers";

// A "why?" timeline lists records from one member's own apps, so it must stay as private as
// the reply it belongs to: not visible to other tenants, nor to teammates in the same workspace.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
const conversation = crypto.randomUUID();
const reply = crypto.randomUUID();

beforeAll(async () => {
  alice = await createAccount("timeline-alice");
  teammate = await createAccount("timeline-mate");
  bob = await createAccount("timeline-bob");
  const ws = await createWorkspace(alice, "Timeline Atelier");
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
    timeline: { question: "alice-why", entries: [{ when: "2026-10-01", what: "alice-refund", verified: true, url: "https://shop.example/1" }], causes: [] },
  });
  expect(inserted.error).toBeNull();
});

describe("message timelines", () => {
  it("are visible only to the member who ran the investigation", async () => {
    const own = await alice.client.from("messages").select("timeline").eq("id", reply).single();
    expect(own.data?.timeline).toMatchObject({ question: "alice-why" });
    expect((await teammate.client.from("messages").select("timeline").eq("id", reply)).data).toEqual([]);
    expect((await bob.client.from("messages").select("timeline").eq("id", reply)).data).toEqual([]);
  });

  it("can't be overwritten by anyone else", async () => {
    for (const other of [teammate, bob]) {
      const update = await other.client.from("messages").update({ timeline: { question: "forged", entries: [], causes: [] } }).eq("id", reply).select("id");
      expect(update.data ?? []).toEqual([]);
    }
    const own = await alice.client.from("messages").select("timeline").eq("id", reply).single();
    expect(own.data?.timeline).toMatchObject({ question: "alice-why" });
  });

  it("rejects non-object timelines", async () => {
    const bad = await alice.client.from("messages").update({ timeline: ["not", "an", "object"] }).eq("id", reply);
    expect(bad.error).not.toBeNull();
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createAccount, createWorkspace, type TestAccount } from "./helpers";

// Forms and proposals the agent shows can quote one member's résumé or plans, and the answers
// they give back are theirs, so both stay as private as the reply they belong to.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
const conversation = crypto.randomUUID();
const reply = crypto.randomUUID();
const form = { kind: "form", id: "f1", title: "alice-search", fields: [{ kind: "text", id: "role", label: "Role", required: true }], submitLabel: "Send" };

beforeAll(async () => {
  alice = await createAccount("ui-alice");
  teammate = await createAccount("ui-mate");
  bob = await createAccount("ui-bob");
  const ws = await createWorkspace(alice, "UI Atelier");
  await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, ws);
  expect((await alice.client.from("conversations").insert({ id: conversation, workspace_id: ws, title: "Setup" })).error).toBeNull();
  const inserted = await alice.client.from("messages").insert({
    id: reply,
    conversation_id: conversation,
    workspace_id: ws,
    role: "assistant",
    content: "",
    status: "complete",
    ui: [form],
  });
  expect(inserted.error).toBeNull();
});

describe("message ui", () => {
  it("is visible only to the member it was shown to", async () => {
    const own = await alice.client.from("messages").select("ui").eq("id", reply).single();
    expect(own.data?.ui).toMatchObject([{ title: "alice-search" }]);
    expect((await teammate.client.from("messages").select("ui").eq("id", reply)).data).toEqual([]);
    expect((await bob.client.from("messages").select("ui").eq("id", reply)).data).toEqual([]);
  });

  it("takes the member's own answers", async () => {
    const answered = await alice.client.from("messages").update({ ui_response: { f1: { status: "submitted", at: 1 } } }).eq("id", reply).select("id");
    expect(answered.error).toBeNull();
    expect(answered.data).toHaveLength(1);
  });

  it("can't be answered or overwritten by anyone else", async () => {
    for (const other of [teammate, bob]) {
      const update = await other.client
        .from("messages")
        .update({ ui: [{ ...form, title: "forged" }], ui_response: { f1: { status: "forged" } } })
        .eq("id", reply)
        .select("id");
      expect(update.data ?? []).toEqual([]);
    }
    const own = await alice.client.from("messages").select("ui, ui_response").eq("id", reply).single();
    expect(own.data?.ui).toMatchObject([{ title: "alice-search" }]);
    expect(own.data?.ui_response).toMatchObject({ f1: { status: "submitted" } });
  });

  it("rejects the wrong shapes", async () => {
    expect((await alice.client.from("messages").update({ ui: { not: "an array" } }).eq("id", reply)).error).not.toBeNull();
    expect((await alice.client.from("messages").update({ ui_response: ["not", "an object"] }).eq("id", reply)).error).not.toBeNull();
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createAccount, createWorkspace, type TestAccount } from "./helpers";

// The setup interview's state lives on the agent's settings: members can read it, only the
// owner can change it, and other tenants can do neither.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
let ws: string;
const setup = { status: "in_progress", conversationId: null, plan: [{ text: "alice-step", status: "doing" }], updatedAt: 1 };

beforeAll(async () => {
  alice = await createAccount("setup-rls-alice");
  teammate = await createAccount("setup-rls-mate");
  bob = await createAccount("setup-rls-bob");
  ws = await createWorkspace(alice, "Setup Atelier");
  await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, ws);
  expect((await alice.client.from("workspace_settings").update({ setup }).eq("workspace_id", ws)).error).toBeNull();
});

describe("agent setup state", () => {
  it("is readable by the agent's members only", async () => {
    expect((await teammate.client.from("workspace_settings").select("setup").eq("workspace_id", ws).single()).data?.setup).toMatchObject({ status: "in_progress" });
    expect((await bob.client.from("workspace_settings").select("setup").eq("workspace_id", ws)).data).toEqual([]);
  });

  it("can only be changed by the owner", async () => {
    for (const other of [teammate, bob]) {
      const update = await other.client.from("workspace_settings").update({ setup: { ...setup, status: "done" } }).eq("workspace_id", ws).select("workspace_id");
      expect(update.data ?? []).toEqual([]);
    }
    const own = await alice.client.from("workspace_settings").select("setup").eq("workspace_id", ws).single();
    expect(own.data?.setup).toMatchObject({ status: "in_progress", plan: [{ text: "alice-step" }] });
  });

  it("must be an object", async () => {
    expect((await alice.client.from("workspace_settings").update({ setup: ["not", "an", "object"] }).eq("workspace_id", ws)).error).not.toBeNull();
  });
});

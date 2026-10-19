import { beforeAll, describe, expect, it } from "vitest";
import { refreshCompanion, getCompanion, getCompanions, KNOWS_YOU } from "@/lib/companion";
import { resolveTenant, sessionFor, type Tenant } from "@/lib/tenant-core";
import { addMember, createAccount, createWorkspace, type TestAccount } from "./helpers";

// Who an agent is to one member is that member's alone: a teammate in the same agent has their
// own, other tenants see nothing, and nobody deletes one or moves it to another agent. It moves
// forward from the member's own runs, and deleting chats never moves it back.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
let ws: string;
let tenant: Tenant;

async function tenantFor(account: TestAccount, workspaceId: string): Promise<Tenant> {
  return (await resolveTenant(sessionFor(account.client as never, { id: account.userId }), workspaceId))!;
}

async function addRuns(count: number, daysAgo: number) {
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const rows = Array.from({ length: count }, () => ({ workspace_id: ws, kind: "agent_run", created_at: at }));
  expect((await alice.client.from("usage_events").insert(rows)).error).toBeNull();
}

async function addConversations(count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  expect((await alice.client.from("conversations").insert(ids.map((id) => ({ id, workspace_id: ws, title: "Chat" })))).error).toBeNull();
  return ids;
}

beforeAll(async () => {
  alice = await createAccount("companion-alice");
  teammate = await createAccount("companion-mate");
  bob = await createAccount("companion-bob");
  ws = await createWorkspace(alice, "Companion Atelier");
  await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, ws);
  tenant = await tenantFor(alice, ws);
});

describe("agent companions", () => {
  it("start as a sketch, with a look of their own", async () => {
    const companion = await getCompanion(tenant);
    expect(companion).toMatchObject({ workspaceId: ws, stage: "sketch", name: null, manner: null });
    expect((await getCompanions(tenant))[ws].look).toEqual(companion.look);
  });

  it("are drawn in after some real use, and ready once it knows them", async () => {
    await addRuns(KNOWS_YOU.drawnRuns, 0);
    expect((await refreshCompanion(tenant, null)).stage).toBe("drawn");

    // Enough runs, but all on one day and in no conversations: still drawn.
    await addRuns(KNOWS_YOU.readyRuns, 0);
    expect((await refreshCompanion(tenant, null)).stage).toBe("drawn");

    await addRuns(1, 2);
    const chats = await addConversations(KNOWS_YOU.readyConversations);
    // Mid-setup it waits for setup to settle.
    expect((await refreshCompanion(tenant, { status: "in_progress", conversationId: null, plan: [], updatedAt: 0 })).stage).toBe("drawn");
    expect((await refreshCompanion(tenant, null)).stage).toBe("ready");

    // Deleting chats never moves it back.
    expect((await alice.client.from("conversations").delete().in("id", chats)).error).toBeNull();
    expect((await refreshCompanion(tenant, null)).stage).toBe("ready");
    expect((await getCompanion(tenant)).stage).toBe("ready");
  });

  it("are private to their member", async () => {
    // The teammate's own companion for the same agent is untouched by Alice's.
    expect((await getCompanion(await tenantFor(teammate, ws))).stage).toBe("sketch");
    expect((await teammate.client.from("agent_companions").select("stage").eq("workspace_id", ws)).data).toEqual([]);
    expect((await bob.client.from("agent_companions").select("stage").eq("workspace_id", ws)).data).toEqual([]);
    const forged = await bob.client.from("agent_companions").insert({ workspace_id: ws, stage: "ready" });
    expect(forged.error).not.toBeNull();
    const update = await bob.client.from("agent_companions").update({ stage: "sketch" }).eq("workspace_id", ws).select("stage");
    expect(update.data ?? []).toEqual([]);
  });

  it("can't be deleted, moved, or arrive without a name", async () => {
    await alice.client.from("agent_companions").delete().eq("workspace_id", ws);
    expect((await getCompanion(tenant)).stage).toBe("ready");
    const moved = await alice.client.from("agent_companions").update({ workspace_id: crypto.randomUUID() }).eq("workspace_id", ws);
    expect(moved.error).not.toBeNull();
    const nameless = await alice.client.from("agent_companions").update({ stage: "arrived" }).eq("workspace_id", ws);
    expect(nameless.error).not.toBeNull();
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { refreshCompanion, getCompanion, getCompanions, KNOWS_YOU, nameCompanion, setCompanionManner } from "@/lib/companion";
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

  it("arrive with the name the member keeps, never theirs or another agent's", async () => {
    // Bob names his own agent June first.
    const bobTenant = await tenantFor(bob, (await resolveTenant(sessionFor(bob.client as never, { id: bob.userId })))!.workspace.id);
    expect((await nameCompanion(bobTenant, { name: "June", member: "Bob" })).ok).toBe(true);

    expect(await nameCompanion(tenant, { name: "Alice", member: "Alice" })).toMatchObject({ ok: false });
    expect(await nameCompanion(tenant, { name: "http://x.test", member: "Alice" })).toMatchObject({ ok: false });
    // Another member's names don't count against hers.
    const kept = await nameCompanion(tenant, { name: "June", manner: "I keep it short.", suggested: "Juniper", member: "Alice" });
    expect(kept).toMatchObject({ ok: true, companion: { stage: "arrived", name: "June", manner: "I keep it short." } });
    expect(await getCompanion(tenant)).toMatchObject({ stage: "arrived", name: "June", manner: "I keep it short." });
    const row = await alice.client.from("agent_companions").select("suggested_name, arrived_at").eq("workspace_id", ws).single();
    expect(row.data).toMatchObject({ suggested_name: "Juniper" });
    expect(row.data?.arrived_at).toBeTruthy();

    // A second agent of hers can't share the name.
    const second = await createWorkspace(alice, "Second");
    expect(await nameCompanion(await tenantFor(alice, second), { name: "june", member: "Alice" })).toMatchObject({ ok: false });

    expect(await setCompanionManner(tenant, "I lead with what I found.")).toMatchObject({ name: "June", manner: "I lead with what I found." });
    // An agent that hasn't arrived has no manner to rewrite.
    expect(await setCompanionManner(await tenantFor(alice, second), "x")).toBeNull();
    // Refreshing never moves it back.
    expect((await refreshCompanion(tenant, null)).stage).toBe("arrived");
  });

  it("can't be deleted, moved, or arrive without a name", async () => {
    await alice.client.from("agent_companions").delete().eq("workspace_id", ws);
    expect((await getCompanion(tenant)).stage).toBe("arrived");
    const moved = await alice.client.from("agent_companions").update({ workspace_id: crypto.randomUUID() }).eq("workspace_id", ws);
    expect(moved.error).not.toBeNull();
    const nameless = await alice.client.from("agent_companions").update({ name: null }).eq("workspace_id", ws);
    expect(nameless.error).not.toBeNull();
  });
});

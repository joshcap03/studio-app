import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createAccount, createWorkspace, type TestAccount } from "./helpers";

// What an agent's brief and skills were before each change: written only by triggers, read only by
// its owners, and put back only by someone allowed to change the part. A try is an ordinary
// conversation with a mark on it, set when it's made.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
let ws: string;
let bobWs: string;

const brief = (account: TestAccount, workspace: string, fields: Record<string, string>) =>
  account.client.from("workspace_settings").update(fields).eq("workspace_id", workspace);
const revisions = (account: TestAccount, workspace: string) =>
  account.client.from("agent_revisions").select("id, part, skill_id, deleted, previous, author").eq("workspace_id", workspace).order("created_at", { ascending: false });

beforeAll(async () => {
  alice = await createAccount("revisions-alice");
  teammate = await createAccount("revisions-mate");
  bob = await createAccount("revisions-bob");
  ws = await createWorkspace(alice, "Revisions Atelier");
  bobWs = await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, ws);
  expect((await brief(bob, bobWs, { business_context: "Bob one" })).error).toBeNull();
  expect((await brief(bob, bobWs, { business_context: "Bob two" })).error).toBeNull();
});

describe("agent_revisions", () => {
  it("doesn't record filling in an empty part", async () => {
    expect((await brief(alice, ws, { agent_instructions: "Keep it short." })).error).toBeNull();
    expect((await revisions(alice, ws)).data).toEqual([]);
  });

  it("records what a part said before a change, once for a burst of edits", async () => {
    expect((await brief(alice, ws, { business_context: "Second words" })).error).toBeNull();
    expect((await brief(alice, ws, { business_context: "Third words" })).error).toBeNull();
    const { data } = await revisions(alice, ws);
    expect(data).toHaveLength(1);
    expect(data?.[0]).toMatchObject({ part: "profile", skill_id: null, deleted: false, previous: { text: "Revisions Atelier context" }, author: alice.userId });
  });

  it("is the owners' to read", async () => {
    expect((await revisions(teammate, ws)).data).toEqual([]);
    expect((await revisions(bob, ws)).data).toEqual([]);
    expect((await revisions(alice, bobWs)).data).toEqual([]);
  });

  it("can't be written or changed directly, even by an owner", async () => {
    const { error: added } = await alice.client.from("agent_revisions").insert({ workspace_id: ws, part: "profile", previous: { text: "forged" } });
    expect(added).not.toBeNull();
    await alice.client.from("agent_revisions").update({ previous: { text: "forged" } }).eq("workspace_id", ws);
    await alice.client.from("agent_revisions").delete().eq("workspace_id", ws);
    const { data } = await revisions(alice, ws);
    expect(data).toHaveLength(1);
    expect(data?.[0].previous).toEqual({ text: "Revisions Atelier context" });
  });

  it("restores for an owner, and a restore can itself be undone", async () => {
    const before = (await revisions(alice, ws)).data!;
    expect((await alice.client.rpc("restore_agent_revision", { revision: before[0].id })).error).toBeNull();
    const { data: settings } = await alice.client.from("workspace_settings").select("business_context").eq("workspace_id", ws).single();
    expect(settings?.business_context).toBe("Revisions Atelier context");
    const after = (await revisions(alice, ws)).data!;
    expect(after).toHaveLength(2);
    expect(after[0].previous).toEqual({ text: "Third words" });
  });

  it("doesn't restore for anyone else", async () => {
    const [latest] = (await revisions(alice, ws)).data!;
    expect((await teammate.client.rpc("restore_agent_revision", { revision: latest.id })).error).not.toBeNull();
    expect((await bob.client.rpc("restore_agent_revision", { revision: latest.id })).error).not.toBeNull();
    const { data: settings } = await alice.client.from("workspace_settings").select("business_context").eq("workspace_id", ws).single();
    expect(settings?.business_context).toBe("Revisions Atelier context");
  });

  it("keeps a deleted skill, and brings it back with its id", async () => {
    const { data: skill, error } = await alice.client.from("workspace_skills").insert({ workspace_id: ws, name: "Digest", instructions: "One" }).select("id").single();
    expect(error).toBeNull();
    expect((await alice.client.from("workspace_skills").update({ instructions: "Two" }).eq("id", skill!.id)).error).toBeNull();
    expect((await alice.client.from("workspace_skills").delete().eq("id", skill!.id)).error).toBeNull();
    const rows = (await revisions(alice, ws)).data!.filter((r) => r.skill_id === skill!.id);
    expect(rows.map((r) => r.deleted)).toEqual([true, false]);
    expect((await alice.client.rpc("restore_agent_revision", { revision: rows[0].id })).error).toBeNull();
    const { data: back } = await alice.client.from("workspace_skills").select("id, instructions").eq("id", skill!.id).single();
    expect(back?.instructions).toBe("Two");
  });

  it("goes with its agent, skills and all", async () => {
    const doomed = await createWorkspace(alice, "Doomed");
    expect((await alice.client.from("workspace_skills").insert({ workspace_id: doomed, name: "Gone", instructions: "Soon" })).error).toBeNull();
    expect((await alice.client.from("workspaces").delete().eq("id", doomed)).error).toBeNull();
    expect((await revisions(alice, doomed)).data).toEqual([]);
  });
});

describe("conversations.is_try", () => {
  it("is set when a conversation is made, and stays", async () => {
    const id = crypto.randomUUID();
    const { error } = await alice.client.from("conversations").insert({ id, title: "A try", is_try: true, workspace_id: ws, user_id: alice.userId });
    expect(error).toBeNull();
    const { error: changed } = await alice.client.from("conversations").update({ is_try: false }).eq("id", id);
    expect(changed).not.toBeNull();
    expect((await alice.client.from("conversations").select("is_try").eq("id", id).single()).data?.is_try).toBe(true);
    expect((await bob.client.from("conversations").select("id").eq("id", id)).data).toEqual([]);
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createAccount, createWorkspace, type TestAccount } from "./helpers";

// A project holds instructions and files for one member's chats, so it is as private as those
// chats: invisible to other tenants and to teammates, and nobody can put their own
// conversation or file into someone else's project.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
let ws: string;
let bobWs: string;
const project = crypto.randomUUID();
const conversation = crypto.randomUUID();
const file = crypto.randomUUID();

beforeAll(async () => {
  alice = await createAccount("projects-alice");
  teammate = await createAccount("projects-mate");
  bob = await createAccount("projects-bob");
  ws = await createWorkspace(alice, "Project Atelier");
  bobWs = await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, ws);
  expect(
    (
      await alice.client.from("projects").insert({
        id: project,
        workspace_id: ws,
        name: "Spring catalog",
        instructions: "alice-secret",
      })
    ).error,
  ).toBeNull();
  expect(
    (
      await alice.client.from("conversations").insert({
        id: conversation,
        workspace_id: ws,
        title: "In project",
        project_id: project,
      })
    ).error,
  ).toBeNull();
  const added = await alice.client.from("project_files").insert({
    id: file,
    project_id: project,
    workspace_id: ws,
    name: "prices.csv",
    mime_type: "text/csv",
    size: 10,
    storage_path: `${ws}/${alice.userId}/projects/${project}/x/prices.csv`,
  });
  expect(added.error).toBeNull();
});

describe("projects", () => {
  it("are visible only to the member who made them", async () => {
    expect((await alice.client.from("projects").select("instructions").eq("id", project).single()).data?.instructions).toBe("alice-secret");
    for (const other of [teammate, bob]) {
      expect((await other.client.from("projects").select("id").eq("id", project)).data).toEqual([]);
      expect((await other.client.from("project_files").select("id").eq("project_id", project)).data).toEqual([]);
    }
  });

  it("can't be changed or deleted by anyone else", async () => {
    for (const other of [teammate, bob]) {
      expect((await other.client.from("projects").update({ instructions: "forged" }).eq("id", project).select("id")).data ?? []).toEqual(
        [],
      );
      expect((await other.client.from("projects").delete().eq("id", project).select("id")).data ?? []).toEqual([]);
    }
    expect((await alice.client.from("projects").select("instructions").eq("id", project).single()).data?.instructions).toBe("alice-secret");
  });

  it("can't take someone else's conversation or file", async () => {
    // A teammate's conversation in Alice's project, in the same workspace.
    const mine = crypto.randomUUID();
    const intoAlice = await teammate.client.from("conversations").insert({
      id: mine,
      workspace_id: ws,
      title: "Mine",
      project_id: project,
    });
    expect(intoAlice.error).not.toBeNull();
    expect((await teammate.client.from("conversations").insert({ id: mine, workspace_id: ws, title: "Mine" })).error).toBeNull();
    expect((await teammate.client.from("conversations").update({ project_id: project }).eq("id", mine)).error).not.toBeNull();

    // Bob can't file anything under Alice's project, even naming her workspace.
    const forged = await bob.client.from("project_files").insert({
      project_id: project,
      workspace_id: bobWs,
      name: "x.csv",
      mime_type: "text/csv",
      size: 1,
      storage_path: `${bobWs}/${bob.userId}/x.csv`,
    });
    expect(forged.error).not.toBeNull();
  });

  it("can't be moved to another workspace or owner", async () => {
    const moved = await alice.client.from("projects").update({ workspace_id: bobWs }).eq("id", project);
    expect(moved.error).not.toBeNull();
  });

  it("take their conversations and files with them when deleted", async () => {
    expect((await alice.client.from("projects").delete().eq("id", project).select("id")).data).toHaveLength(1);
    expect((await alice.client.from("conversations").select("id").eq("id", conversation)).data).toEqual([]);
    expect((await alice.client.from("project_files").select("id").eq("id", file)).data).toEqual([]);
  });
});

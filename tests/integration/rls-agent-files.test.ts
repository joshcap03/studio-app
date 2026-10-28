import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createAccount, createWorkspace, type TestAccount } from "./helpers";

// A member's files for an agent (their résumé) go with every run of that agent, so they are
// as private as the member's chats: invisible to other tenants and to teammates, never filed
// under someone else's name or workspace, and never moved once added.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
let ws: string;
let bobWs: string;
const file = crypto.randomUUID();

const row = (workspace: string, user: string, name = "resume.pdf") => ({
  workspace_id: workspace,
  name,
  mime_type: "application/pdf",
  size: 10,
  storage_path: `${workspace}/${user}/agent/${crypto.randomUUID()}/${name}`,
});

beforeAll(async () => {
  alice = await createAccount("agentfiles-alice");
  teammate = await createAccount("agentfiles-mate");
  bob = await createAccount("agentfiles-bob");
  ws = await createWorkspace(alice, "Files Atelier");
  bobWs = await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, ws);
  expect((await alice.client.from("agent_files").insert({ id: file, ...row(ws, alice.userId, "alice-resume.pdf") })).error).toBeNull();
});

describe("agent files", () => {
  it("let their member note where the agent service has them, and no one else", async () => {
    const sent = { sent_to: "langflow:0123456789abcdef", sent_id: "f-1", sent_path: "u/f-1.pdf", sent_at: new Date().toISOString() };
    const own = await alice.client.from("agent_files").update(sent).eq("id", file).select("sent_to, sent_id, sent_path");
    expect(own.data).toEqual([{ sent_to: sent.sent_to, sent_id: "f-1", sent_path: "u/f-1.pdf" }]);
    for (const other of [teammate, bob]) {
      expect((await other.client.from("agent_files").update({ ...sent, sent_id: "f-forged" }).eq("id", file).select("id")).data ?? []).toEqual([]);
    }
    // Nothing else about a file changes after it's added.
    expect((await alice.client.from("agent_files").update({ name: "renamed.pdf" }).eq("id", file)).error).not.toBeNull();
  });

  it("are visible only to the member who added them", async () => {
    expect((await alice.client.from("agent_files").select("name").eq("id", file).single()).data?.name).toBe("alice-resume.pdf");
    for (const other of [teammate, bob]) {
      expect((await other.client.from("agent_files").select("id").eq("id", file)).data).toEqual([]);
      expect((await other.client.from("agent_files").select("id").eq("workspace_id", ws)).data).toEqual([]);
    }
  });

  it("can't be removed by anyone else", async () => {
    for (const other of [teammate, bob]) {
      expect((await other.client.from("agent_files").delete().eq("id", file).select("id")).data ?? []).toEqual([]);
    }
    expect((await alice.client.from("agent_files").select("id").eq("id", file)).data).toHaveLength(1);
  });

  it("can't be added under someone else, another workspace, or another member's folder", async () => {
    // Bob naming Alice's workspace, or Alice as the owner.
    expect((await bob.client.from("agent_files").insert(row(ws, bob.userId))).error).not.toBeNull();
    expect((await bob.client.from("agent_files").insert({ ...row(bobWs, alice.userId), user_id: alice.userId })).error).not.toBeNull();
    // A teammate filing into Alice's name in their shared workspace.
    expect((await teammate.client.from("agent_files").insert({ ...row(ws, alice.userId), user_id: alice.userId })).error).not.toBeNull();
    // Bytes outside the member's own folder.
    expect((await bob.client.from("agent_files").insert({ ...row(bobWs, bob.userId), storage_path: `${ws}/${alice.userId}/x.pdf` })).error).not.toBeNull();
    // Their own shelf in their own workspace works.
    expect((await teammate.client.from("agent_files").insert(row(ws, teammate.userId))).error).toBeNull();
  });

  it("can't be moved to another workspace or owner, or renamed", async () => {
    expect((await alice.client.from("agent_files").update({ workspace_id: bobWs }).eq("id", file)).error).not.toBeNull();
    expect((await alice.client.from("agent_files").update({ user_id: bob.userId }).eq("id", file)).error).not.toBeNull();
    expect((await alice.client.from("agent_files").update({ storage_path: `${ws}/${alice.userId}/other.pdf` }).eq("id", file)).error).not.toBeNull();
  });

  it("hold at most ten per member per agent", async () => {
    const carol = await createAccount("agentfiles-carol");
    const carolWs = await createWorkspace(carol, "Capped");
    const ten = Array.from({ length: 10 }, (_, i) => row(carolWs, carol.userId, `f${i}.pdf`));
    expect((await carol.client.from("agent_files").insert(ten)).error).toBeNull();
    const eleventh = await carol.client.from("agent_files").insert(row(carolWs, carol.userId, "f10.pdf"));
    expect(eleventh.error?.message).toMatch(/limit/);
    // Another agent of the same person has its own shelf.
    const other = await createWorkspace(carol, "Second agent");
    expect((await carol.client.from("agent_files").insert(row(other, carol.userId))).error).toBeNull();
  });

  describe("claiming an uploaded file", () => {
    async function upload(account: TestAccount, workspace: string) {
      const { data, error } = await account.client
        .from("attachments")
        .insert(row(workspace, account.userId, "upload.pdf"))
        .select("id, storage_path")
        .single();
      expect(error).toBeNull();
      return data as { id: string; storage_path: string };
    }

    it("moves the member's own unsent upload onto their shelf, keeping its id and bytes", async () => {
      const a = await upload(alice, ws);
      const claimed = await alice.client.rpc("claim_agent_file", { p_attachment: a.id, p_workspace: ws });
      expect(claimed.error).toBeNull();
      expect(claimed.data).toBe(a.id);
      expect((await alice.client.from("attachments").select("id").eq("id", a.id)).data).toEqual([]);
      expect((await alice.client.from("agent_files").select("storage_path").eq("id", a.id).single()).data?.storage_path).toBe(a.storage_path);
      // Claiming twice finds nothing.
      expect((await alice.client.rpc("claim_agent_file", { p_attachment: a.id, p_workspace: ws })).data).toBeNull();
    });

    it("won't take someone else's upload, or file it under another workspace", async () => {
      const a = await upload(alice, ws);
      for (const [other, workspace] of [
        [teammate, ws],
        [bob, bobWs],
        [bob, ws],
      ] as const) {
        const forged = await other.client.rpc("claim_agent_file", { p_attachment: a.id, p_workspace: workspace });
        expect(forged.data ?? null).toBeNull();
      }
      // Alice naming another workspace doesn't move it either.
      expect((await alice.client.rpc("claim_agent_file", { p_attachment: a.id, p_workspace: bobWs })).data).toBeNull();
      expect((await alice.client.from("attachments").select("id").eq("id", a.id)).data).toHaveLength(1);
    });

    it("leaves the upload alone when the shelf is full", async () => {
      const dana = await createAccount("agentfiles-dana");
      const danaWs = await createWorkspace(dana, "Full");
      const ten = Array.from({ length: 10 }, (_, i) => row(danaWs, dana.userId, `f${i}.pdf`));
      expect((await dana.client.from("agent_files").insert(ten)).error).toBeNull();
      const a = await upload(dana, danaWs);
      const claimed = await dana.client.rpc("claim_agent_file", { p_attachment: a.id, p_workspace: danaWs });
      expect(claimed.error?.message).toMatch(/limit/);
      expect((await dana.client.from("attachments").select("id").eq("id", a.id)).data).toHaveLength(1);
    });
  });
});

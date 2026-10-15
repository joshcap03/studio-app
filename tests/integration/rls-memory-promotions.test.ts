import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createAccount, createWorkspace, type TestAccount } from "./helpers";

// Business Brain's share requests: a member asks, only an owner decides, and nobody outside
// the workspace sees anything.

let owner: TestAccount;
let member: TestAccount;
let outsider: TestAccount;
let ws: string;
let request: string;

beforeAll(async () => {
  owner = await createAccount("brain-owner");
  member = await createAccount("brain-member");
  outsider = await createAccount("brain-outsider");
  ws = await createWorkspace(owner, "Brain Atelier");
  await createWorkspace(outsider, "Elsewhere");
  await addMember(member, ws);

  const inserted = await member.client
    .from("memory_promotions")
    .insert({ workspace_id: ws, personal_doc_id: "doc_1", content: "member-secret-fact", category: "suppliers" })
    .select("id")
    .single();
  expect(inserted.error).toBeNull();
  request = inserted.data!.id;
});

describe("memory promotions", () => {
  it("are visible to the requester and the owner, and to nobody else", async () => {
    expect((await member.client.from("memory_promotions").select("id")).data).toEqual([{ id: request }]);
    expect((await owner.client.from("memory_promotions").select("id")).data).toEqual([{ id: request }]);
    expect((await outsider.client.from("memory_promotions").select("*")).data).toEqual([]);
  });

  it("can't be filed for someone else, into another workspace, or already decided", async () => {
    const forOwner = await member.client
      .from("memory_promotions")
      .insert({ workspace_id: ws, requested_by: owner.userId, personal_doc_id: "doc_2", content: "x" });
    expect(forOwner.error).not.toBeNull();
    const elsewhere = await outsider.client.from("memory_promotions").insert({ workspace_id: ws, personal_doc_id: "doc_3", content: "x" });
    expect(elsewhere.error).not.toBeNull();
    const preApproved = await member.client
      .from("memory_promotions")
      .insert({ workspace_id: ws, personal_doc_id: "doc_4", content: "x", status: "approved" });
    expect(preApproved.error).not.toBeNull();
  });

  it("allows one pending request per memory", async () => {
    const again = await member.client.from("memory_promotions").insert({ workspace_id: ws, personal_doc_id: "doc_1", content: "again" });
    expect(again.error?.code).toBe("23505");
  });

  it("can't be decided by the requester or an outsider", async () => {
    const self = await member.client.from("memory_promotions").update({ status: "approved", decided_by: member.userId }).eq("id", request).select("id");
    expect(self.error).not.toBeNull();
    const outside = await outsider.client.from("memory_promotions").update({ status: "approved" }).eq("id", request).select("id");
    expect(outside.data ?? []).toEqual([]);
    const content = await owner.client.from("memory_promotions").update({ content: "rewritten" }).eq("id", request);
    expect(content.error).not.toBeNull();
    const row = await owner.client.from("memory_promotions").select("status, content").eq("id", request).single();
    expect(row.data).toEqual({ status: "pending", content: "member-secret-fact" });
  });

  it("is decided by the owner, recorded under the owner", async () => {
    const forged = await owner.client.from("memory_promotions").update({ status: "approved", decided_by: member.userId }).eq("id", request);
    expect(forged.error).not.toBeNull();
    const decided = await owner.client
      .from("memory_promotions")
      .update({ status: "approved", decided_by: owner.userId, decided_at: new Date().toISOString() })
      .eq("id", request)
      .select("status")
      .single();
    expect(decided.error).toBeNull();
    expect(decided.data?.status).toBe("approved");
    // The requester may then mark their personal copy cleaned up, and nothing else.
    expect((await member.client.from("memory_promotions").update({ cleaned: true }).eq("id", request)).error).toBeNull();
    expect((await member.client.from("memory_promotions").update({ status: "rejected" }).eq("id", request)).error).not.toBeNull();
  });
});

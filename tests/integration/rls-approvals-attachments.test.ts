import { beforeAll, describe, expect, it } from "vitest";
import { createAccount, createWorkspace, type TestAccount } from "./helpers";

// Isolation for approvals, attachments (rows and Storage objects), and memory proposals.
// Bob holds a valid session and tries to reach Alice's rows and files directly.

let alice: TestAccount;
let bob: TestAccount;
let aliceWs: string;
let bobWs: string;
const aliceConv = crypto.randomUUID();
const aliceReply = crypto.randomUUID();
let aliceApproval: string;
let aliceFile: string;
let alicePath: string;

beforeAll(async () => {
  alice = await createAccount("alice");
  bob = await createAccount("bob");
  aliceWs = await createWorkspace(alice, "Alice Atelier");
  bobWs = await createWorkspace(bob, "Bob Bakery");

  expect((await alice.client.from("conversations").insert({ id: aliceConv, workspace_id: aliceWs, title: "Plans" })).error).toBeNull();
  const reply = await alice.client.from("messages").insert({
    id: aliceReply,
    conversation_id: aliceConv,
    workspace_id: aliceWs,
    role: "assistant",
    content: "",
    status: "awaiting",
    memory_proposals: [{ id: crypto.randomUUID(), content: "alice-memory-idea", scope: "workspace", status: "pending" }],
  });
  expect(reply.error).toBeNull();
  const approval = await alice.client
    .from("approvals")
    .insert({
      workspace_id: aliceWs,
      conversation_id: aliceConv,
      message_id: aliceReply,
      summary: "Send alice-secret-email",
      provider: "langflow",
      provider_state: { jobId: "alice-job" },
    })
    .select("id")
    .single();
  expect(approval.error).toBeNull();
  aliceApproval = approval.data!.id;

  alicePath = `${aliceWs}/${alice.userId}/${crypto.randomUUID()}/orders.csv`;
  const upload = await alice.client.storage.from("attachments").upload(alicePath, new Blob(["alice-file-bytes"], { type: "text/csv" }), { contentType: "text/csv" });
  expect(upload.error).toBeNull();
  const file = await alice.client
    .from("attachments")
    .insert({ workspace_id: aliceWs, name: "orders.csv", mime_type: "text/csv", size: 16, storage_path: alicePath })
    .select("id")
    .single();
  expect(file.error).toBeNull();
  aliceFile = file.data!.id;
});

describe("approvals", () => {
  it("are invisible to other tenants, provider state included", async () => {
    const { data, error } = await bob.client.from("approvals").select("*");
    expect(error).toBeNull();
    expect(data).toEqual([]);
    const own = await alice.client.from("approvals").select("provider_state").eq("id", aliceApproval).single();
    expect(own.data?.provider_state).toEqual({ jobId: "alice-job" });
  });

  it("can't be answered or created by another tenant", async () => {
    const update = await bob.client.from("approvals").update({ status: "approved" }).eq("id", aliceApproval).select("id");
    expect(update.data ?? []).toEqual([]);
    const forged = await bob.client.from("approvals").insert({
      workspace_id: aliceWs,
      conversation_id: aliceConv,
      message_id: aliceReply,
      summary: "forged",
      provider: "langflow",
    });
    expect(forged.error).not.toBeNull();
    // Pointing a row in Bob's own workspace at Alice's reply fails the composite key.
    const crossed = await bob.client.from("approvals").insert({
      workspace_id: bobWs,
      conversation_id: aliceConv,
      message_id: aliceReply,
      summary: "crossed",
      provider: "langflow",
    });
    expect(crossed.error).not.toBeNull();
  });

  it("let their owner change only the decision, never what the agent asked or how to resume it", async () => {
    const summary = await alice.client.from("approvals").update({ summary: "edited" }).eq("id", aliceApproval);
    expect(summary.error).not.toBeNull();
    const state = await alice.client.from("approvals").update({ provider_state: { jobId: "other" } }).eq("id", aliceApproval);
    expect(state.error).not.toBeNull();
  });

  it("allow one pending request per conversation", async () => {
    const second = await alice.client.from("approvals").insert({
      workspace_id: aliceWs,
      conversation_id: aliceConv,
      message_id: aliceReply,
      summary: "second",
      provider: "langflow",
    });
    expect(second.error).not.toBeNull();
  });
});

describe("memory proposals", () => {
  it("stay with their reply, private to its owner", async () => {
    const { data } = await bob.client.from("messages").select("memory_proposals").eq("id", aliceReply);
    expect(data).toEqual([]);
  });
});

describe("attachments", () => {
  it("hide another tenant's file rows and bytes", async () => {
    expect((await bob.client.from("attachments").select("*")).data).toEqual([]);
    const download = await bob.client.storage.from("attachments").download(alicePath);
    expect(download.data).toBeNull();
    const listing = await bob.client.storage.from("attachments").list(`${aliceWs}/${alice.userId}`);
    expect(listing.data ?? []).toEqual([]);
    const own = await alice.client.storage.from("attachments").download(alicePath);
    expect(await own.data?.text()).toBe("alice-file-bytes");
  });

  it("can't be claimed onto another tenant's message", async () => {
    const claim = await bob.client.from("attachments").update({ message_id: aliceReply }).eq("id", aliceFile).select("id");
    expect(claim.data ?? []).toEqual([]);
  });

  it("can't be written into another tenant's folder, by row or by file", async () => {
    const path = `${aliceWs}/${alice.userId}/${crypto.randomUUID()}/planted.csv`;
    const upload = await bob.client.storage.from("attachments").upload(path, new Blob(["x"]));
    expect(upload.error).not.toBeNull();
    const ownFolderOtherWorkspace = await bob.client.storage
      .from("attachments")
      .upload(`${aliceWs}/${bob.userId}/${crypto.randomUUID()}/planted.csv`, new Blob(["x"]));
    expect(ownFolderOtherWorkspace.error).not.toBeNull();
    const row = await bob.client
      .from("attachments")
      .insert({ workspace_id: bobWs, name: "x.csv", mime_type: "text/csv", size: 1, storage_path: alicePath });
    expect(row.error).not.toBeNull(); // the path must sit in Bob's own folder
  });

  it("let their owner change only which message they belong to", async () => {
    const moved = await alice.client.from("attachments").update({ storage_path: `${aliceWs}/${alice.userId}/x` }).eq("id", aliceFile);
    expect(moved.error).not.toBeNull();
  });

  it("can't be deleted by another tenant", async () => {
    await bob.client.storage.from("attachments").remove([alicePath]);
    const still = await alice.client.storage.from("attachments").download(alicePath);
    expect(still.data).not.toBeNull();
  });
});

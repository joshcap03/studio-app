import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccount, createWorkspace, serviceClient, type TestAccount } from "./helpers";

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

describe("spoken approvals", () => {
  // A request of Alice's, classified voice-ok when the agent asked, and one that's a tap.
  let voiceOk: string;
  let tapOnly: string;
  let aliceCall: string;
  const reports: string[] = [];

  beforeAll(async () => {
    const conv = crypto.randomUUID();
    const reply = crypto.randomUUID();
    expect((await alice.client.from("conversations").insert({ id: conv, workspace_id: aliceWs, title: "Spoken" })).error).toBeNull();
    expect((await alice.client.from("messages").insert({ id: reply, conversation_id: conv, workspace_id: aliceWs, role: "assistant", content: "", status: "awaiting" })).error).toBeNull();
    const row = (extra: Record<string, unknown>) => ({ workspace_id: aliceWs, conversation_id: conv, message_id: reply, summary: "Send alice-spoken-email", provider: "mock", ...extra });
    const ok = await alice.client.from("approvals").insert(row({ voice_ok: true, read_back: "I'll email jo@acme.example.", tools: ["GMAIL_SEND_EMAIL"] })).select("id").single();
    expect(ok.error).toBeNull();
    voiceOk = ok.data!.id;
    // A conversation holds one pending request at a time: the tap-only one is already decided by hand.
    const tap = await alice.client.from("approvals").insert(row({ tap_only: "money", status: "approved" })).select("id").single();
    expect(tap.error).toBeNull();
    tapOnly = tap.data!.id;
    expect((await alice.client.from("approvals").update({ decided_via: "tap" }).eq("id", tapOnly)).error).toBeNull();
  });

  afterAll(async () => {
    // Members can't clear the trip wire; the test clears what it tripped, as an operator would.
    if (reports.length) await (await serviceClient()).from("spoken_approval_reports").delete().in("approval_id", reports);
  });

  it("can't be classified voice-ok without a read-back, or be both voice-ok and a tap", async () => {
    const conv = (await alice.client.from("approvals").select("conversation_id, message_id").eq("id", voiceOk).single()).data!;
    const base = { workspace_id: aliceWs, conversation_id: conv.conversation_id, message_id: conv.message_id, summary: "x", provider: "mock", status: "declined" };
    expect((await alice.client.from("approvals").insert({ ...base, voice_ok: true })).error).not.toBeNull();
    expect((await alice.client.from("approvals").insert({ ...base, voice_ok: true, read_back: "x", tap_only: "money" })).error).not.toBeNull();
    expect((await alice.client.from("approvals").insert({ ...base, tap_only: "lottery" })).error).not.toBeNull();
  });

  it("can't be written already decided by voice, or reported", async () => {
    const conv = (await alice.client.from("approvals").select("conversation_id, message_id").eq("id", voiceOk).single()).data!;
    const base = { workspace_id: aliceWs, conversation_id: conv.conversation_id, message_id: conv.message_id, summary: "x", provider: "mock", voice_ok: true, read_back: "x", status: "declined" };
    for (const extra of [{ decided_via: "voice" }, { decided_words: "send it" }, { decided_call: crypto.randomUUID() }, { decided_via: "tap" }, { reported_at: new Date().toISOString() }]) {
      expect((await alice.client.from("approvals").insert({ ...base, ...extra })).error, JSON.stringify(extra)).not.toBeNull();
    }
  });

  it("let their owner record a tap, never change what was classified or how a spoken decision was made", async () => {
    for (const patch of [{ voice_ok: false }, { tap_only: "money" }, { read_back: "something else" }, { tools: [] }, { reported_at: new Date().toISOString() }, { decided_words: "send it" }, { decided_call: crypto.randomUUID() }]) {
      expect((await alice.client.from("approvals").update(patch).eq("id", voiceOk)).error, JSON.stringify(patch)).not.toBeNull();
    }
    // Spoken words go only with a spoken decision, and a spoken decision needs its words.
    expect((await alice.client.from("approvals").update({ decided_via: "tap", decided_words: "send it" }).eq("id", voiceOk)).error).not.toBeNull();
    expect((await alice.client.from("approvals").update({ status: "approved", decided_via: "voice" }).eq("id", voiceOk)).error).not.toBeNull();
  });

  it("can't mark a request that's a tap as approved by voice", async () => {
    const forged = await alice.client.from("approvals").update({ decided_via: "voice", decided_words: "send it" }).eq("id", tapOnly);
    expect(forged.error).not.toBeNull();
  });

  it("don't let another tenant record a decision on them", async () => {
    const stolen = await bob.client.from("approvals").update({ status: "approved", decided_via: "voice", decided_words: "send it" }).eq("id", voiceOk).select("id");
    expect(stolen.data ?? []).toEqual([]);
    expect((await alice.client.from("approvals").select("status").eq("id", voiceOk).single()).data?.status).toBe("pending");
  });

  it("are recorded as spoken only on their owner's own open call, and only voice-ok ones approved", async () => {
    const settle = (who: TestAccount, approval: string, decision: string, call: string) =>
      who.client.rpc("settle_spoken_approval", { p_approval: approval, p_decision: decision, p_call: call, p_words: "send it" });
    // No call, or someone else's.
    expect((await settle(alice, voiceOk, "approved", crypto.randomUUID())).data).toBe(false);
    const bobs = (await bob.client.rpc("claim_voice", { ws: bobWs, p_provider: "mock", p_daily_seconds: 3600, p_call_seconds: 600 })).data![0].session_id as string;
    expect((await settle(alice, voiceOk, "approved", bobs)).data).toBe(false);
    expect((await settle(bob, voiceOk, "approved", bobs)).data).toBe(false);
    await bob.client.rpc("end_voice_session", { p_id: bobs });
    // A call that's over.
    const ended = (await alice.client.rpc("claim_voice", { ws: aliceWs, p_provider: "mock", p_daily_seconds: 3600, p_call_seconds: 600 })).data![0].session_id as string;
    await alice.client.rpc("end_voice_session", { p_id: ended });
    expect((await settle(alice, voiceOk, "approved", ended)).data).toBe(false);
    // A request that's a tap, or already answered.
    const call = (await alice.client.rpc("claim_voice", { ws: aliceWs, p_provider: "mock", p_daily_seconds: 3600, p_call_seconds: 600 })).data![0].session_id as string;
    expect((await settle(alice, tapOnly, "approved", call)).data).toBe(false);
    expect((await alice.client.from("approvals").select("status, decided_via").eq("id", voiceOk).single()).data).toEqual({ status: "pending", decided_via: null });
    aliceCall = call;
  });

  it("can be reported only by their owner, once approved by voice on their call, and the report trips the wire for everyone", async () => {
    const report = (who: TestAccount, conversation: string, approval: string) => who.client.rpc("report_spoken_approval", { p_conversation: conversation, p_approval: approval });
    const conv = (await alice.client.from("approvals").select("conversation_id").eq("id", voiceOk).single()).data!.conversation_id as string;
    // Not decided by voice yet, or decided by hand: nothing to report.
    expect((await report(alice, conv, voiceOk)).data).toBe(false);
    expect((await report(alice, conv, tapOnly)).data).toBe(false);
    // A spoken approval written by hand, without a call, can't be made, so it can't trip the wire.
    expect((await alice.client.from("approvals").update({ status: "approved", decided_at: new Date().toISOString(), decided_via: "voice" }).eq("id", voiceOk)).error).not.toBeNull();
    expect((await report(alice, conv, voiceOk)).data).toBe(false);
    expect((await bob.client.rpc("spoken_approvals_off")).data).toBe(false);
    const settled = await alice.client.rpc("settle_spoken_approval", { p_approval: voiceOk, p_decision: "approved", p_call: aliceCall, p_words: "send it" });
    expect(settled.data).toBe(true);
    const decided = await alice.client.from("approvals").select("decided_via, decided_words, decided_call").eq("id", voiceOk).single();
    expect(decided.data).toEqual({ decided_via: "voice", decided_words: "send it", decided_call: aliceCall });
    // Recorded once: a second spoken decision, or a tap over it, doesn't change it.
    expect((await alice.client.rpc("settle_spoken_approval", { p_approval: voiceOk, p_decision: "declined", p_call: aliceCall, p_words: "no" })).data).toBe(false);
    expect((await alice.client.from("approvals").update({ decided_via: "tap" }).eq("id", voiceOk)).error).not.toBeNull();
    await alice.client.rpc("end_voice_session", { p_id: aliceCall });
    // Someone else's, or under another conversation: refused.
    expect((await report(bob, conv, voiceOk)).data).toBe(false);
    expect((await report(alice, crypto.randomUUID(), voiceOk)).data).toBe(false);
    expect((await bob.client.rpc("spoken_approvals_off")).data).toBe(false);

    reports.push(voiceOk);
    expect((await report(alice, conv, voiceOk)).data).toBe(true);
    expect((await report(alice, conv, voiceOk)).data).toBe(true);
    // Off for everyone, Bob included.
    expect((await bob.client.rpc("spoken_approvals_off")).data).toBe(true);
    expect((await alice.client.from("approvals").select("reported_at").eq("id", voiceOk).single()).data?.reported_at).toEqual(expect.any(String));
  });

  it("keep reports private and out of members' hands", async () => {
    const own = await alice.client.from("spoken_approval_reports").select("approval_id");
    expect(own.data).toEqual([{ approval_id: voiceOk }]);
    expect((await bob.client.from("spoken_approval_reports").select("approval_id")).data).toEqual([]);
    // Whose it was isn't readable, even by its owner.
    expect((await alice.client.from("spoken_approval_reports").select("user_id")).error).not.toBeNull();
    // Nobody but the database writes or clears them.
    expect((await alice.client.from("spoken_approval_reports").insert({ approval_id: voiceOk })).error).not.toBeNull();
    await alice.client.from("spoken_approval_reports").delete().eq("approval_id", voiceOk);
    expect((await alice.client.rpc("spoken_approvals_off")).data).toBe(true);
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

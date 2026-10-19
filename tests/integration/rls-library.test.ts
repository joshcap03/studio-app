import { beforeAll, describe, expect, it } from "vitest";
import { addLink, fileArtifact, listLibrary, removeLibraryItem, updateLibraryItem } from "@/lib/library";
import type { Tenant } from "@/lib/tenant";
import { addMember, createAccount, createWorkspace, type TestAccount } from "./helpers";

// The Library (docs the agent made for a member, links they filed) is as private as their
// chats: invisible to teammates and other tenants, never filed under someone else or another
// agent, never pointed at someone else's chat, and its links can't be swapped after the fact.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
let ws: string;
let bobWs: string;
let message: string;
const conversation = crypto.randomUUID();
const item = crypto.randomUUID();
const bobConversation = crypto.randomUUID();

const row = (workspace: string, url = `https://docs.google.com/document/d/${crypto.randomUUID()}`) => ({
  workspace_id: workspace,
  kind: "document",
  title: "Cover letter",
  url,
  added_by: "agent",
});

const tenantOf = (account: TestAccount, workspace: string) =>
  ({ db: account.client, userId: account.userId, email: account.email, workspace: { id: workspace } }) as unknown as Tenant;

beforeAll(async () => {
  alice = await createAccount("library-alice");
  teammate = await createAccount("library-mate");
  bob = await createAccount("library-bob");
  ws = await createWorkspace(alice, "Library Atelier");
  bobWs = await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, ws);
  expect((await alice.client.from("conversations").insert({ id: conversation, workspace_id: ws, title: "Letters" })).error).toBeNull();
  expect((await bob.client.from("conversations").insert({ id: bobConversation, workspace_id: bobWs, title: "Bob's" })).error).toBeNull();
  const sent = await alice.client
    .from("messages")
    .insert({ conversation_id: conversation, workspace_id: ws, role: "assistant", content: "Here it is.", status: "complete" })
    .select("id")
    .single();
  expect(sent.error).toBeNull();
  message = sent.data!.id;
  expect((await alice.client.from("agent_artifacts").insert({ id: item, ...row(ws), conversation_id: conversation, source_message_id: message })).error).toBeNull();
});

describe("the Library", () => {
  it("is visible only to the member it belongs to", async () => {
    expect((await alice.client.from("agent_artifacts").select("title").eq("id", item).single()).data?.title).toBe("Cover letter");
    for (const other of [teammate, bob]) {
      expect((await other.client.from("agent_artifacts").select("id").eq("id", item)).data).toEqual([]);
      expect((await other.client.from("agent_artifacts").select("id").eq("workspace_id", ws)).data).toEqual([]);
    }
  });

  it("can't be changed or emptied by anyone else", async () => {
    for (const other of [teammate, bob]) {
      expect((await other.client.from("agent_artifacts").update({ title: "Mine now" }).eq("id", item).select("id")).data ?? []).toEqual([]);
      expect((await other.client.from("agent_artifacts").delete().eq("id", item).select("id")).data ?? []).toEqual([]);
    }
    expect((await alice.client.from("agent_artifacts").select("title").eq("id", item).single()).data?.title).toBe("Cover letter");
  });

  it("can't be filed under someone else, another agent, or someone else's chat", async () => {
    expect((await bob.client.from("agent_artifacts").insert(row(ws))).error).not.toBeNull();
    expect((await bob.client.from("agent_artifacts").insert({ ...row(bobWs), user_id: alice.userId })).error).not.toBeNull();
    expect((await teammate.client.from("agent_artifacts").insert({ ...row(ws), user_id: alice.userId })).error).not.toBeNull();
    // Alice's own row, pointed at Bob's chat or a teammate's view of hers.
    expect((await alice.client.from("agent_artifacts").insert({ ...row(ws), conversation_id: bobConversation })).error).not.toBeNull();
    expect((await teammate.client.from("agent_artifacts").insert({ ...row(ws), conversation_id: conversation })).error).not.toBeNull();
    expect((await teammate.client.from("agent_artifacts").insert(row(ws))).error).toBeNull();
  });

  it("only takes https links and known kinds", async () => {
    for (const url of ["http://example.com/doc", "javascript:alert(1)", "ftp://example.com/x"]) {
      expect((await alice.client.from("agent_artifacts").insert(row(ws, url))).error).not.toBeNull();
    }
    expect((await alice.client.from("agent_artifacts").insert({ ...row(ws), kind: "script" })).error).not.toBeNull();
    expect((await alice.client.from("agent_artifacts").insert({ ...row(ws), added_by: "admin" })).error).not.toBeNull();
  });

  it("keeps its links, owners, and who filed it fixed; the member may rename and pin", async () => {
    expect((await alice.client.from("agent_artifacts").update({ url: "https://evil.example/x" }).eq("id", item)).error).not.toBeNull();
    expect((await alice.client.from("agent_artifacts").update({ workspace_id: bobWs }).eq("id", item)).error).not.toBeNull();
    expect((await alice.client.from("agent_artifacts").update({ user_id: bob.userId }).eq("id", item)).error).not.toBeNull();
    expect((await alice.client.from("agent_artifacts").update({ added_by: "member" }).eq("id", item)).error).not.toBeNull();
    expect((await alice.client.from("agent_artifacts").update({ title: "Letter v2", pinned: true }).eq("id", item)).error).toBeNull();
  });

  it("files the same doc once, moving it up for the chat that made it again", async () => {
    const tenant = tenantOf(alice, ws);
    const url = "https://docs.google.com/spreadsheets/d/tracker";
    const artifact = { id: "s1", kind: "spreadsheet" as const, title: "Job search tracker", url, source: "Google Sheets" };
    const first = await fileArtifact(tenant, artifact, { conversationId: conversation, messageId: message });
    await alice.client.from("agent_artifacts").update({ title: "My tracker" }).eq("id", first!.id);
    const again = await fileArtifact(tenant, { ...artifact, title: "Renamed by the agent" }, { conversationId: conversation, messageId: message });
    expect(again).toMatchObject({ id: first!.id, title: "My tracker", addedBy: "agent", conversationId: conversation });
    // A link the member pastes that's already there says so.
    await expect(addLink(tenant, { url })).rejects.toMatchObject({ status: 409 });
    const pasted = await addLink(tenant, { url: "https://docs.google.com/document/d/mine" });
    expect(pasted).toMatchObject({ kind: "document", source: "Google Docs", title: "Google Doc", addedBy: "member" });
    // Pinned first.
    await updateLibraryItem(tenant, pasted.id, { pinned: true });
    expect((await listLibrary(tenant))[0].id).toBe(pasted.id);
    // Someone else can't reach it through the app's own functions either.
    expect(await updateLibraryItem(tenantOf(teammate, ws), pasted.id, { title: "x" })).toBeNull();
    expect(await removeLibraryItem(tenantOf(bob, bobWs), pasted.id)).toBe(false);
    expect(await removeLibraryItem(tenant, pasted.id)).toBe(true);
  });

  it("holds at most 500 per member per agent", async () => {
    const carol = await createAccount("library-carol");
    const carolWs = await createWorkspace(carol, "Capped");
    const many = Array.from({ length: 500 }, (_, i) => row(carolWs, `https://example.com/${i}`));
    expect((await carol.client.from("agent_artifacts").insert(many)).error).toBeNull();
    const extra = await carol.client.from("agent_artifacts").insert(row(carolWs));
    expect(extra.error?.hint).toBe("artifact_limit");
    // The agent filing one more leaves the reply alone; a pasted link says why.
    const tenant = tenantOf(carol, carolWs);
    expect(await fileArtifact(tenant, { id: "x", kind: "file", title: "x", url: "https://example.com/new" }, { conversationId: crypto.randomUUID(), messageId: crypto.randomUUID() })).toBeNull();
    await expect(addLink(tenant, { url: "https://example.com/pasted" })).rejects.toMatchObject({ status: 409 });
    // Another agent of the same person has its own shelf.
    const other = await createWorkspace(carol, "Second agent");
    expect((await carol.client.from("agent_artifacts").insert(row(other))).error).toBeNull();
  });

  it("lets go of a deleted chat", async () => {
    expect((await alice.client.from("conversations").delete().eq("id", conversation)).error).toBeNull();
    const kept = await alice.client.from("agent_artifacts").select("conversation_id, source_message_id").eq("id", item).single();
    expect(kept.data).toEqual({ conversation_id: null, source_message_id: null });
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { browserFilesFor } from "@/lib/browser-files";
import type { Tenant } from "@/lib/tenant";
import { createAccount, createWorkspace, type TestAccount } from "./helpers";

// Files the agent's browser got for a member (save_file) are ordinary attachments on its reply,
// marked by browser_md5. Each run lists only the member's own, from that conversation, and
// another member's session can't see or mark one.

let alice: TestAccount;
let bob: TestAccount;
let aliceWs: string;
const conversation = crypto.randomUUID();
const other = crypto.randomUUID();
const MD5 = "0123456789abcdef0123456789abcdef";

const tenantOf = (account: TestAccount, workspace: string) =>
  ({ db: account.client, userId: account.userId, email: account.email, workspace: { id: workspace } }) as unknown as Tenant;

async function reply(conversationId: string): Promise<string> {
  const id = crypto.randomUUID();
  expect((await alice.client.from("messages").insert({ id, conversation_id: conversationId, workspace_id: aliceWs, role: "assistant", content: "", status: "complete" })).error).toBeNull();
  return id;
}

async function file(messageId: string, name: string, md5: string | null) {
  const path = `${aliceWs}/${alice.userId}/${crypto.randomUUID()}/${name}`;
  expect((await alice.client.storage.from("attachments").upload(path, new Blob(["%PDF-1.4"], { type: "application/pdf" }), { contentType: "application/pdf" })).error).toBeNull();
  const row = await alice.client
    .from("attachments")
    .insert({ workspace_id: aliceWs, message_id: messageId, name, mime_type: "application/pdf", size: 8, storage_path: path, browser_md5: md5 })
    .select("id")
    .single();
  expect(row.error).toBeNull();
  return row.data!.id as string;
}

beforeAll(async () => {
  alice = await createAccount("bf-alice");
  bob = await createAccount("bf-bob");
  aliceWs = await createWorkspace(alice, "Alice Shop");
  await createWorkspace(bob, "Bob Shop");
  for (const id of [conversation, other]) {
    expect((await alice.client.from("conversations").insert({ id, workspace_id: aliceWs, title: "Labels" })).error).toBeNull();
  }
  const here = await reply(conversation);
  await file(here, "Label 1.pdf", MD5);
  await file(here, "Label 2.pdf", MD5);
  // A file the member attached isn't from the browser, and another conversation's isn't this one's.
  await file(here, "Mine.pdf", null);
  await file(await reply(other), "Elsewhere.pdf", MD5);
});

describe("files from the agent's browser", () => {
  it("are listed for the conversation they were got in, newest first, and only those", async () => {
    const files = await browserFilesFor(tenantOf(alice, aliceWs), conversation);
    expect(files.map((f) => f.name)).toEqual(["Label 2.pdf", "Label 1.pdf"]);
    expect(files[0].mimeType).toBe("application/pdf");
  });

  it("can't be listed or marked by anyone else", async () => {
    expect(await browserFilesFor(tenantOf(bob, aliceWs), conversation)).toEqual([]);
    const marked = await bob.client.from("attachments").select("id").not("browser_md5", "is", null);
    expect(marked.data).toEqual([]);
    const mine = (await alice.client.from("attachments").select("id").eq("name", "Mine.pdf").single()).data!.id as string;
    const change = await alice.client.from("attachments").update({ browser_md5: MD5 }).eq("id", mine).select("id");
    expect(change.error).not.toBeNull();
  });

  it("take only a real digest", async () => {
    const id = await reply(conversation);
    const bad = await alice.client
      .from("attachments")
      .insert({ workspace_id: aliceWs, message_id: id, name: "x.pdf", mime_type: "application/pdf", size: 8, storage_path: `${aliceWs}/${alice.userId}/${crypto.randomUUID()}/x.pdf`, browser_md5: "nope" });
    expect(bad.error).not.toBeNull();
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { resolveTenant, sessionFor } from "@/lib/tenant-core";
import { lastMissedBatch } from "@/lib/verdicts";
import { addMember, createAccount, createWorkspace, type TestAccount } from "./helpers";

// A member's keep/pass calls are their own standard: no one else in the agent, and no other
// tenant, can read or add to them, and once made they aren't rewritten.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
let ws: string;
const conversation = crypto.randomUUID();
const reply = crypto.randomUUID();
const block = crypto.randomUUID();
const row = () => ({ workspace_id: ws, message_id: reply, block_id: block, item_id: "acme", title: "Senior Designer · Acme", verdict: "pass", reason: "Too junior" });

beforeAll(async () => {
  alice = await createAccount("verdict-alice");
  teammate = await createAccount("verdict-mate");
  bob = await createAccount("verdict-bob");
  ws = await createWorkspace(alice, "Verdict Atelier");
  await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, ws);
  expect((await alice.client.from("conversations").insert({ id: conversation, workspace_id: ws, title: "Trial run" })).error).toBeNull();
  expect((await alice.client.from("messages").insert({ id: reply, conversation_id: conversation, workspace_id: ws, role: "assistant", content: "", status: "complete" })).error).toBeNull();
  expect((await alice.client.from("agent_verdicts").insert(row())).error).toBeNull();
});

describe("agent verdicts", () => {
  it("are visible only to the member who made them", async () => {
    expect((await alice.client.from("agent_verdicts").select("title, verdict, reason").eq("message_id", reply)).data).toEqual([
      { title: "Senior Designer · Acme", verdict: "pass", reason: "Too junior" },
    ]);
    expect((await teammate.client.from("agent_verdicts").select("id").eq("message_id", reply)).data).toEqual([]);
    expect((await bob.client.from("agent_verdicts").select("id").eq("message_id", reply)).data).toEqual([]);
  });

  it("can't be added on someone else's reply or agent", async () => {
    // The teammate belongs to the agent, but the reply is alice's.
    expect((await teammate.client.from("agent_verdicts").insert({ ...row(), item_id: "mate" })).error).not.toBeNull();
    expect((await bob.client.from("agent_verdicts").insert({ ...row(), item_id: "bob" })).error).not.toBeNull();
  });

  it("aren't rewritten, and hold only keep or pass", async () => {
    const update = await alice.client.from("agent_verdicts").update({ verdict: "keep" }).eq("message_id", reply).select("id");
    expect(update.error).not.toBeNull();
    expect((await alice.client.from("agent_verdicts").insert({ ...row(), item_id: "maybe", verdict: "maybe" })).error).not.toBeNull();
  });
});

describe("the last results a member judged", () => {
  const chat = crypto.randomUUID();
  const other = crypto.randomUUID();
  const current = crypto.randomUUID();
  const card = crypto.randomUUID();
  const tenantOf = async (account: TestAccount, workspace?: string) =>
    (await resolveTenant(sessionFor(account.client, { id: account.userId, email: account.email }), workspace))!;
  const say = async (conversationId: string, content: string, extra: Record<string, unknown> = {}) =>
    expect((await alice.client.from("messages").insert({ conversation_id: conversationId, workspace_id: ws, role: "user", content, status: "complete", ...extra })).error).toBeNull();

  beforeAll(async () => {
    for (const id of [chat, other, current]) {
      expect((await alice.client.from("conversations").insert({ id, workspace_id: ws, title: "Roles" })).error).toBeNull();
    }
    expect((await alice.client.from("messages").insert({ id: card, conversation_id: chat, workspace_id: ws, role: "assistant", content: "", status: "complete" })).error).toBeNull();
    const pass = (item_id: string, title: string, reason: string | null) => ({ workspace_id: ws, message_id: card, block_id: block, item_id, title, verdict: "pass", reason });
    expect(
      (await alice.client.from("agent_verdicts").insert([pass("coast", "Senior PM · Coast", "Too early-stage"), pass("fomo", "PM · Fomo", null), pass("ramp", "Staff PM · Ramp", "Not NYC")])).error,
    ).toBeNull();
    await say(chat, "Trial run:\n- Passed: Senior PM · Coast (Too early-stage)");
    await say(other, "Only Series B+ fintech in NYC, no consumer apps");
    await say(other, "Find new roles", { origin: { kind: "task", taskId: crypto.randomUUID(), title: "Find new roles", runId: crypto.randomUUID() } });
    await say(current, "");
    await say(current, "Find me more roles");
  });

  it("is the member's own miss, with what they've said in other chats since", async () => {
    const batch = await lastMissedBatch(await tenantOf(alice, ws), current);
    expect(batch).toMatchObject({ judged: 3, kept: 0, since: ["Only Series B+ fintech in NYC, no consumer apps"] });
    expect(batch!.items.map((i) => i.title).sort()).toEqual(["PM · Fomo", "Senior PM · Coast", "Staff PM · Ramp"]);
    // In the card's own chat, its answer isn't counted, and that chat's later words are in view anyway.
    expect((await lastMissedBatch(await tenantOf(alice, ws), other))!.since).toEqual(["Find me more roles"]);
  });

  it("is never anyone else's", async () => {
    expect(await lastMissedBatch(await tenantOf(teammate, ws), current)).toBeUndefined();
    expect(await lastMissedBatch(await tenantOf(bob), current)).toBeUndefined();
  });
});

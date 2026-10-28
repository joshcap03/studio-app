import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./helpers";

// The route the background worker calls to carry on a chat reply's job with no page open: it
// takes only a member's access token, carries on only that member's own reply while it's still
// waiting, once, and runs it in the app (mock agent). The members are fixed accounts reused across
// runs on the local stack. Requires the QA server on APP_URL.

const APP = process.env.APP_URL ?? "http://127.0.0.1:3100";
const PASSWORD = "pw-local-worker-keep-going-only";

interface Member {
  db: SupabaseClient;
  token: string;
  workspaceId: string;
}

async function member(email: string): Promise<Member> {
  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const signedIn = await db.auth.signInWithPassword({ email, password: PASSWORD });
  const session = signedIn.data.session ?? (await db.auth.signUp({ email, password: PASSWORD })).data.session;
  expect(session).toBeTruthy();
  const { data: rows } = await db.from("workspace_members").select("workspace_id").limit(1);
  let workspaceId = rows?.[0]?.workspace_id as string | undefined;
  if (!workspaceId) {
    const created = await db.rpc("create_workspace", { p_name: `${email.split("@")[0]} space` });
    expect(created.error).toBeNull();
    workspaceId = created.data as string;
  }
  return { db, token: session!.access_token, workspaceId };
}

let alice: Member;
let bob: Member;

beforeAll(async () => {
  const health = await fetch(`${APP}/login`).catch(() => null);
  if (!health) throw new Error(`QA server not reachable at ${APP}; run npm run qa:serve`);
  alice = await member("worker-keep-alice@example.test");
  bob = await member("worker-keep-bob@example.test");
}, 60_000);

/** One of Alice's conversations whose latest reply carries the job on, as a reply that ran out of time leaves it. */
async function waitingReply(): Promise<{ conversation: string; reply: string }> {
  const conversation = crypto.randomUUID();
  const reply = crypto.randomUUID();
  expect((await alice.db.from("conversations").insert({ id: conversation, workspace_id: alice.workspaceId, title: "Tagging" })).error).toBeNull();
  const ask = await alice.db.from("messages").insert({ conversation_id: conversation, workspace_id: alice.workspaceId, role: "user", content: "Tag my mail and keep going.", status: "complete" });
  expect(ask.error).toBeNull();
  const answer = await alice.db
    .from("messages")
    .insert({ id: reply, conversation_id: conversation, workspace_id: alice.workspaceId, role: "assistant", content: "Labeled the first 200.", status: "complete", keep_going: "label the remaining threads" });
  expect(answer.error).toBeNull();
  return { conversation, reply };
}

const carryOn = (r: { conversation: string; reply: string }, as: Member, workspaceId = as.workspaceId) =>
  fetch(`${APP}/api/conversations/${r.conversation}/keep-going?workspace=${workspaceId}&reply=${r.reply}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${as.token}` },
  });

const replies = async (conversation: string) =>
  ((await alice.db.from("messages").select("role, status, content").eq("conversation_id", conversation).order("created_at")).data ?? []) as {
    role: string;
    status: string;
    content: string;
  }[];

describe("carrying on a chat reply's job for the worker", () => {
  it("carries the member's own waiting reply on once, in the same conversation, and answers how it ended", async () => {
    const r = await waitingReply();
    try {
      const res = await carryOn(r, alice);
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await res.json()).toEqual({ status: "carried_on", reply: "complete", keepGoing: false });
      const after = await replies(r.conversation);
      expect(after.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
      expect(after.at(-1)).toMatchObject({ status: "complete", content: expect.stringMatching(/rest of the threads are labeled/) });
      // Once is all: that reply isn't waiting anymore.
      expect(await (await carryOn(r, alice)).json()).toMatchObject({ status: "taken" });
      expect(await replies(r.conversation)).toHaveLength(3);
    } finally {
      await alice.db.from("conversations").delete().eq("id", r.conversation);
    }
  }, 60_000);

  it("does nothing once the member wrote after it", async () => {
    const r = await waitingReply();
    try {
      await alice.db.from("messages").insert({ conversation_id: r.conversation, workspace_id: alice.workspaceId, role: "user", content: "Stop, just the newest", status: "complete" });
      expect(await (await carryOn(r, alice)).json()).toMatchObject({ status: "taken" });
      expect(await replies(r.conversation)).toHaveLength(3);
    } finally {
      await alice.db.from("conversations").delete().eq("id", r.conversation);
    }
  }, 60_000);

  it("refuses without a member's token, and never carries on another member's reply", async () => {
    const r = await waitingReply();
    try {
      const url = `${APP}/api/conversations/${r.conversation}/keep-going?workspace=${alice.workspaceId}&reply=${r.reply}`;
      expect((await fetch(url, { method: "POST" })).status).toBe(401);
      expect((await fetch(url, { method: "POST", headers: { Authorization: "Bearer not-a-token" } })).status).toBe(401);
      // Bob's token, whether he names Alice's workspace or his own.
      expect((await carryOn(r, bob, alice.workspaceId)).status).toBe(404);
      expect(await (await carryOn(r, bob)).json()).toMatchObject({ status: "taken" });
      expect(await replies(r.conversation)).toHaveLength(2);
    } finally {
      await alice.db.from("conversations").delete().eq("id", r.conversation);
    }
  }, 60_000);

  it("takes a token on this route only: the conversation's other routes still need a signed-in session", async () => {
    const r = await waitingReply();
    const auth = { Authorization: `Bearer ${alice.token}` };
    try {
      expect((await fetch(`${APP}/api/conversations/${r.conversation}`, { headers: auth })).status).toBe(401);
      expect((await fetch(`${APP}/api/conversations/${r.conversation}/stop`, { method: "POST", headers: auth })).status).toBe(401);
      expect((await fetch(`${APP}/api/conversations/${r.conversation}/keep-going`, { method: "GET", headers: auth })).status).toBe(401);
    } finally {
      await alice.db.from("conversations").delete().eq("id", r.conversation);
    }
  });
});

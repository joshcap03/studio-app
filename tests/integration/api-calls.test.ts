import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./helpers";

// Calls from any conversation, through the app's HTTP API with the mock voice and the mock agent
// (`npm run qa:serve` allowlists these accounts for the voice preview): words said on a call are
// tied to the call only when it's the caller's own, a conversation lists the calls its messages
// were said on (for their recaps), a reply that finishes after the call ended comes back as a
// voice note, and the agent's offer to call is taken only with a call that's really going and
// the member's own, once. Requires the QA server and the local Supabase stack.

const APP = process.env.APP_URL ?? "http://127.0.0.1:3100";
const PASSWORD = "pw-local-voice-api-only";

class Client {
  private cookies = new Map<string, string>();

  async json(path: string, method: string, body?: unknown): Promise<Response> {
    const res = await fetch(APP + path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      headers: { Origin: APP, "Content-Type": "application/json", Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    for (const header of res.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const index = pair.indexOf("=");
      const value = pair.slice(index + 1);
      if (value === "" || /max-age=0/i.test(header)) this.cookies.delete(pair.slice(0, index));
      else this.cookies.set(pair.slice(0, index), value);
    }
    return res;
  }

  /** Runs a turn; the reply as its end event carried it. */
  async turn(conversationId: string, body: unknown): Promise<{ id: string; voiceNote?: { script: string; source: string } | null; ui?: { kind: string }[] }> {
    const res = await this.json(`/api/conversations/${conversationId}/messages`, "POST", body);
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const end = text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; message?: { id: string; voiceNote?: { script: string; source: string } | null; ui?: { kind: string }[] } })
      .find((e) => e.type === "end");
    expect(end?.message).toBeTruthy();
    return end!.message!;
  }
}

interface Member {
  api: Client;
  db: SupabaseClient;
  workspaceId: string;
}

async function member(email: string): Promise<Member> {
  const api = new Client();
  if ((await api.json("/api/auth/signin", "POST", { email, password: PASSWORD })).status !== 200) {
    const res = await api.json("/api/auth/signup", "POST", { email, password: PASSWORD });
    expect(res.status, await res.clone().text()).toBe(200);
  }
  const listed = (await (await api.json("/api/workspaces", "GET")).json()) as { active: string | null };
  let workspaceId = listed.active;
  if (!workspaceId) {
    const res = await api.json("/api/workspaces", "POST", { name: `${email.split("@")[0]} agent` });
    expect(res.status).toBe(201);
    workspaceId = ((await res.json()) as { workspaceId: string }).workspaceId;
  }
  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  expect((await db.auth.signInWithPassword({ email, password: PASSWORD })).error).toBeNull();
  return { api, db, workspaceId };
}

async function startCall(who: Member): Promise<string> {
  const res = await who.api.json("/api/voice/session", "POST", {});
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { grant: { sessionId: string } }).grant.sessionId;
}

const endCall = async (who: Member, id: string) => expect((await who.api.json(`/api/voice/session/${id}/end`, "POST", {})).status).toBe(200);

interface Thread {
  messages: { id: string; role: string; origin?: unknown; voiceNote?: unknown }[];
  calls: { id: string; startedAt: number; endedAt: number | null }[];
}
const thread = async (who: Member, id: string) => (await (await who.api.json(`/api/conversations/${id}`, "GET")).json()) as Thread;

let alice: Member;
let bob: Member;
const made: string[] = [];

beforeAll(async () => {
  const health = await fetch(`${APP}/login`).catch(() => null);
  if (!health) throw new Error(`QA server not reachable at ${APP}; run npm run qa:serve`);
  alice = await member("voice-api-alice@example.test");
  bob = await member("voice-api-bob@example.test");
}, 60_000);

afterAll(async () => {
  for (const id of made) await alice?.api.json(`/api/conversations/${id}`, "DELETE");
});

describe("words said on a call", () => {
  it("carry the call when it's the caller's own, and the conversation lists it, ended once it's over", async () => {
    const conversation = crypto.randomUUID();
    made.push(conversation);
    const call = await startCall(alice);
    await alice.api.turn(conversation, { kind: "send", text: "Find me remote roles", modality: "call", voiceSessionId: call });
    let shown = await thread(alice, conversation);
    expect(shown.messages[0].origin).toEqual({ kind: "voice", sessionId: call });
    expect(shown.calls).toEqual([{ id: call, startedAt: expect.any(Number), endedAt: null }]);
    await endCall(alice, call);
    shown = await thread(alice, conversation);
    expect(shown.calls[0].endedAt).toEqual(expect.any(Number));
    // No one else sees it, or its call.
    expect((await bob.api.json(`/api/conversations/${conversation}`, "GET")).status).toBe(404);
  });

  it("are only spoken words when the call is someone else's", async () => {
    const conversation = crypto.randomUUID();
    made.push(conversation);
    const theirs = await startCall(bob);
    await alice.api.turn(conversation, { kind: "send", text: "Find me remote roles", modality: "call", voiceSessionId: theirs });
    const shown = await thread(alice, conversation);
    expect(shown.messages[0].origin).toEqual({ kind: "voice" });
    expect(shown.calls).toEqual([]);
    await endCall(bob, theirs);
    // Not a uuid: refused outright.
    expect((await alice.api.json(`/api/conversations/${conversation}/messages`, "POST", { kind: "send", text: "x", modality: "call", voiceSessionId: "nope" })).status).toBe(400);
  });

  it("get their reply as a voice note when it finished after the member hung up", async () => {
    const conversation = crypto.randomUUID();
    made.push(conversation);
    const call = await startCall(alice);
    // Still on the call: the call reads the reply out.
    const live = await alice.api.turn(conversation, { kind: "send", text: "What's on my plate today", modality: "call", voiceSessionId: call });
    expect(live.voiceNote ?? null).toBeNull();
    // Words that reach the server just after they hung up still belong to the call, and nothing reads that reply out.
    await endCall(alice, call);
    const late = await alice.api.turn(conversation, { kind: "send", text: "And tomorrow?", modality: "call", voiceSessionId: call });
    expect(late.voiceNote?.source).toBe("reply");
    expect((await thread(alice, conversation)).messages.at(-2)?.origin).toEqual({ kind: "voice", sessionId: call });
  });
});

describe("the agent's offer to call", () => {
  const conversation = crypto.randomUUID();
  const offerId = crypto.randomUUID();
  const secondId = crypto.randomUUID();
  const url = (blockId: string) => `/api/conversations/${conversation}/ui/${blockId}`;

  beforeAll(async () => {
    made.push(conversation);
    expect((await alice.db.from("conversations").insert({ id: conversation, workspace_id: alice.workspaceId, title: "Offers" })).error).toBeNull();
    const inserted = await alice.db.from("messages").insert({
      conversation_id: conversation,
      workspace_id: alice.workspaceId,
      role: "assistant",
      content: "Three trade-offs here.",
      status: "complete",
      ui: [
        { kind: "offer", id: offerId, reason: "Quicker to talk it through." },
        { kind: "offer", id: secondId, reason: "Still worth a call." },
      ],
    });
    expect(inserted.error).toBeNull();
  });

  it("is taken only with a call that's going and the member's own, once", async () => {
    const theirs = await startCall(bob);
    expect((await alice.api.json(url(offerId), "POST", { action: "accept", sessionId: theirs })).status).toBe(404);
    await endCall(bob, theirs);
    const ended = await startCall(alice);
    await endCall(alice, ended);
    expect((await alice.api.json(url(offerId), "POST", { action: "accept", sessionId: ended })).status).toBe(404);

    const call = await startCall(alice);
    // Not the member's card: as if it weren't there.
    expect((await bob.api.json(url(offerId), "POST", { action: "accept", sessionId: call })).status).toBe(404);
    const res = await alice.api.json(url(offerId), "POST", { action: "accept", sessionId: call });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { response: unknown }).response).toEqual({ status: "accepted", at: expect.any(Number), sessionId: call });
    expect((await alice.api.json(url(offerId), "POST", { action: "decline" })).status).toBe(409);
    await endCall(alice, call);
  });

  it("is turned down once, and only an offer can be", async () => {
    expect((await bob.api.json(url(secondId), "POST", { action: "decline" })).status).toBe(404);
    const res = await alice.api.json(url(secondId), "POST", { action: "decline" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { response: unknown }).response).toEqual({ status: "declined", at: expect.any(Number) });
    expect((await alice.api.json(url(secondId), "POST", { action: "decline" })).status).toBe(409);
    expect((await alice.api.json(url(secondId), "POST", { action: "submit" })).status).toBe(400);
  });
});

describe("offers to call", () => {
  it("reach only pages that can show them: a tab still on older code would break on one", async () => {
    const conversation = crypto.randomUUID();
    made.push(conversation);
    // The mock agent offers a call when asked to; a page that doesn't say it knows offers gets none.
    const older = await alice.api.turn(conversation, { kind: "send", text: "Should we hop on a call?" });
    expect(older.ui ?? []).toEqual([]);
    const newer = await alice.api.turn(conversation, { kind: "send", text: "Hop on a call?", offers: true });
    expect(newer.ui).toEqual([expect.objectContaining({ kind: "offer" })]);
    // Loading the conversation: without the offer unless the page asks for offers.
    const plain = (await (await alice.api.json(`/api/conversations/${conversation}`, "GET")).json()) as { messages: { id: string; ui?: { kind: string }[] }[] };
    expect(plain.messages.find((m) => m.id === newer.id)?.ui).toEqual([]);
    const knows = (await (await alice.api.json(`/api/conversations/${conversation}?offers=1`, "GET")).json()) as { messages: { id: string; ui?: { kind: string }[] }[] };
    expect(knows.messages.find((m) => m.id === newer.id)?.ui).toEqual([expect.objectContaining({ kind: "offer" })]);
  });
});

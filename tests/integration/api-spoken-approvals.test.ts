import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serviceClient, SUPABASE_ANON_KEY, SUPABASE_URL } from "./helpers";

// Spoken approvals through the app's HTTP API, with the mock voice and the mock agent (`npm run
// qa:serve` allowlists these accounts for the voice preview): a request is classified when the
// agent asks; one that's voice-ok is approved by voice only with a clear yes on the member's own
// open call, and the words are kept; a tap-only one, or someone else's call, or a call that's
// over, is refused and the request keeps waiting; a decline can be said for any request; and a
// report that a spoken approval wasn't what they said turns spoken approval off for everyone
// (the test clears it again, as an operator would with SQL). Requires the QA server and the local
// Supabase stack.

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

  /** Runs a turn; its status, and its events when it ran. */
  async turn(conversationId: string, body: unknown) {
    const res = await this.json(`/api/conversations/${conversationId}/messages`, "POST", body);
    const text = await res.text();
    const events = res.ok ? text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; [k: string]: unknown }) : [];
    return { status: res.status, text, events };
  }
}

interface Member {
  api: Client;
  db: SupabaseClient;
}

async function member(email: string): Promise<Member> {
  const api = new Client();
  if ((await api.json("/api/auth/signin", "POST", { email, password: PASSWORD })).status !== 200) {
    const res = await api.json("/api/auth/signup", "POST", { email, password: PASSWORD });
    expect(res.status, await res.clone().text()).toBe(200);
  }
  const listed = (await (await api.json("/api/workspaces", "GET")).json()) as { active: string | null };
  if (!listed.active) expect((await api.json("/api/workspaces", "POST", { name: `${email.split("@")[0]} agent` })).status).toBe(201);
  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  expect((await db.auth.signInWithPassword({ email, password: PASSWORD })).error).toBeNull();
  return { api, db };
}

async function startCall(who: Member): Promise<{ sessionId: string; spokenApprovals?: boolean }> {
  const res = await who.api.json("/api/voice/session", "POST", {});
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { grant: { sessionId: string; spokenApprovals?: boolean } }).grant;
}
const endCall = async (who: Member, id: string) => expect((await who.api.json(`/api/voice/session/${id}/end`, "POST", {})).status).toBe(200);

interface PublicApproval {
  id: string;
  status: string;
  spoken?: { ok: boolean; readBack?: string; reason?: string };
  decidedVia?: string;
  decidedWords?: string;
}

/** A request waiting on the member, from the mock agent: an email reply (voice-ok), or a payment (a tap). */
async function waiting(who: Member, ask: string): Promise<{ conversation: string; approval: PublicApproval }> {
  const conversation = crypto.randomUUID();
  made.push(conversation);
  const { events } = await who.api.turn(conversation, { kind: "send", text: `non-streaming ${ask}` });
  const approval = events.find((e) => e.type === "approval")?.approval as PublicApproval | undefined;
  expect(approval).toBeTruthy();
  return { conversation, approval: approval! };
}

const decide = (who: Member, conversation: string, approvalId: string, extra: Record<string, unknown>) =>
  who.api.turn(conversation, { kind: "decide", approvalId, decision: "approve", ...extra });

let alice: Member;
let bob: Member;
const made: string[] = [];
const reported: string[] = [];

beforeAll(async () => {
  const health = await fetch(`${APP}/login`).catch(() => null);
  if (!health) throw new Error(`QA server not reachable at ${APP}; run npm run qa:serve`);
  alice = await member("voice-api-alice@example.test");
  bob = await member("voice-api-bob@example.test");
}, 60_000);

afterAll(async () => {
  if (reported.length) await (await serviceClient()).from("spoken_approval_reports").delete().in("approval_id", reported);
  for (const id of made) await alice?.api.json(`/api/conversations/${id}`, "DELETE");
});

describe("a request the agent asks for", () => {
  it("is classified when it asks, from what it would run, never from its summary", async () => {
    const reply = await waiting(alice, "email Casting Co about the duplicate payment");
    expect(reply.approval.spoken).toEqual({ ok: true, readBack: expect.stringContaining("billing@casting.example") });
    const payment = await waiting(alice, "pay the Casting Co invoice");
    expect(payment.approval.spoken).toEqual({ ok: false, reason: "money" });
  });
});

describe("approving by voice", () => {
  it("takes a clear yes on the member's own open call, and keeps their words", async () => {
    const call = await startCall(alice);
    expect(call.spokenApprovals).toBe(true);
    const { conversation, approval } = await waiting(alice, "email Casting Co about the duplicate payment");
    const done = await decide(alice, conversation, approval.id, { via: "voice", heard: "send it", voiceSessionId: call.sessionId });
    expect(done.status, done.text).toBe(200);
    expect(done.events.at(-1)).toMatchObject({ type: "end", message: { status: "complete", approvals: [{ status: "approved", decidedVia: "voice", decidedWords: "send it" }] } });
    const stored = await alice.db.from("approvals").select("status, decided_via, decided_words").eq("id", approval.id).single();
    expect(stored.data).toEqual({ status: "approved", decided_via: "voice", decided_words: "send it" });
    await endCall(alice, call.sessionId);
  });

  it("refuses anything less, and the request keeps waiting for a tap", async () => {
    const call = await startCall(alice);
    const { conversation, approval } = await waiting(alice, "email Casting Co about the duplicate payment");
    // Not a clear yes.
    expect((await decide(alice, conversation, approval.id, { via: "voice", heard: "yes", voiceSessionId: call.sessionId })).status).toBe(403);
    expect((await decide(alice, conversation, approval.id, { via: "voice", heard: "send it to Sam", voiceSessionId: call.sessionId })).status).toBe(403);
    // Someone else's call, or none.
    const theirs = await startCall(bob);
    expect((await decide(alice, conversation, approval.id, { via: "voice", heard: "send it", voiceSessionId: theirs.sessionId })).status).toBe(403);
    await endCall(bob, theirs.sessionId);
    expect((await decide(alice, conversation, approval.id, { via: "voice", heard: "send it" })).status).toBe(400);
    expect((await decide(alice, conversation, approval.id, { via: "voice", voiceSessionId: call.sessionId })).status).toBe(400);
    // A call that's over.
    await endCall(alice, call.sessionId);
    expect((await decide(alice, conversation, approval.id, { via: "voice", heard: "send it", voiceSessionId: call.sessionId })).status).toBe(403);
    const still = await alice.db.from("approvals").select("status, decided_via").eq("id", approval.id).single();
    expect(still.data).toEqual({ status: "pending", decided_via: null });
    // A tap still answers it, and says so.
    const tapped = await decide(alice, conversation, approval.id, {});
    expect(tapped.status).toBe(200);
    expect((await alice.db.from("approvals").select("decided_via, decided_words").eq("id", approval.id).single()).data).toEqual({ decided_via: "tap", decided_words: null });
  });

  it("never approves a tap-only request by voice, and lets any request be declined by voice", async () => {
    const call = await startCall(alice);
    const { conversation, approval } = await waiting(alice, "pay the Casting Co invoice");
    expect((await decide(alice, conversation, approval.id, { via: "voice", heard: "send it", voiceSessionId: call.sessionId })).status).toBe(403);
    const declined = await alice.api.turn(conversation, { kind: "decide", approvalId: approval.id, decision: "reject", via: "voice", heard: "don't send it", voiceSessionId: call.sessionId });
    expect(declined.status, declined.text).toBe(200);
    expect((await alice.db.from("approvals").select("status, decided_via, decided_words").eq("id", approval.id).single()).data).toEqual({
      status: "declined",
      decided_via: "voice",
      decided_words: "don't send it",
    });
    await endCall(alice, call.sessionId);
  });

  it("is a decision only its owner can make", async () => {
    const call = await startCall(bob);
    const { conversation, approval } = await waiting(alice, "email Casting Co about the duplicate payment");
    expect((await decide(bob, conversation, approval.id, { via: "voice", heard: "send it", voiceSessionId: call.sessionId })).status).toBe(404);
    await endCall(bob, call.sessionId);
  });
});

describe("that's not what I said", () => {
  it("turns spoken approval off for everyone: the next call says approvals are taps, and a spoken yes is refused", async () => {
    const call = await startCall(alice);
    const first = await waiting(alice, "email Casting Co about the duplicate payment");
    expect((await decide(alice, first.conversation, first.approval.id, { via: "voice", heard: "go ahead", voiceSessionId: call.sessionId })).status).toBe(200);
    // Only a spoken approval of their own can be reported.
    expect((await bob.api.json(`/api/conversations/${first.conversation}/approvals/${first.approval.id}/report`, "POST", {})).status).toBe(404);
    reported.push(first.approval.id);
    expect((await alice.api.json(`/api/conversations/${first.conversation}/approvals/${first.approval.id}/report`, "POST", {})).status).toBe(200);
    const loaded = (await (await alice.api.json(`/api/conversations/${first.conversation}`, "GET")).json()) as { messages: { approvals?: PublicApproval[] }[] };
    expect(loaded.messages.flatMap((m) => m.approvals ?? [])[0]).toMatchObject({ decidedVia: "voice", decidedWords: "go ahead", reported: true });

    const second = await waiting(alice, "email Casting Co about the duplicate payment");
    expect((await decide(alice, second.conversation, second.approval.id, { via: "voice", heard: "send it", voiceSessionId: call.sessionId })).status).toBe(403);
    await endCall(alice, call.sessionId);
    // Bob's next call, too.
    const bobs = await startCall(bob);
    expect(bobs.spokenApprovals).toBe(false);
    await endCall(bob, bobs.sessionId);
    // A tap-decided one can't be reported.
    expect((await decide(alice, second.conversation, second.approval.id, {})).status).toBe(200);
    expect((await alice.api.json(`/api/conversations/${second.conversation}/approvals/${second.approval.id}/report`, "POST", {})).status).toBe(404);
  });
});

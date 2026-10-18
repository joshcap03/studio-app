import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createAccount, createWorkspace, serviceClient, type TestAccount } from "./helpers";

// Voice calls are private to the member who made them: no other tenant or teammate sees or ends
// them, members can't write a call's timing themselves, and claim_voice holds each person to
// their daily voice time across all their agents.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
let aliceWs: string;
let bobWs: string;

type Claim = { session_id: string | null; max_seconds: number; refused: string | null };

async function claim(account: TestAccount, ws: string, daily = 1800, call = 1500): Promise<Claim> {
  const { data, error } = await account.client.rpc("claim_voice", { ws, p_provider: "mock", p_daily_seconds: daily, p_call_seconds: call });
  if (error) throw error;
  return (data as Claim[])[0];
}

beforeAll(async () => {
  alice = await createAccount("voice-alice");
  teammate = await createAccount("voice-mate");
  bob = await createAccount("voice-bob");
  aliceWs = await createWorkspace(alice, "Voice Atelier");
  bobWs = await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, aliceWs);
});

describe("voice sessions", () => {
  it("start for the caller in an agent they belong to, and only there", async () => {
    const own = await claim(alice, aliceWs);
    expect(own.refused).toBeNull();
    expect(own.max_seconds).toBe(1500);
    const row = await alice.client.from("voice_sessions").select("user_id, workspace_id, provider, ended_at").eq("id", own.session_id!).single();
    expect(row.data).toEqual({ user_id: alice.userId, workspace_id: aliceWs, provider: "mock", ended_at: null });

    const elsewhere = await bob.client.rpc("claim_voice", { ws: aliceWs, p_provider: "mock", p_daily_seconds: 1800, p_call_seconds: 1500 });
    expect(elsewhere.error).not.toBeNull();
  });

  it("are visible only to the member who called", async () => {
    expect((await alice.client.from("voice_sessions").select("id")).data?.length).toBeGreaterThan(0);
    expect((await teammate.client.from("voice_sessions").select("id")).data).toEqual([]);
    expect((await bob.client.from("voice_sessions").select("id")).data).toEqual([]);
  });

  it("can't be inserted, retimed, or deleted directly", async () => {
    const forged = await bob.client.from("voice_sessions").insert({ workspace_id: bobWs, provider: "mock", max_seconds: 60 });
    expect(forged.error).not.toBeNull();
    const { session_id } = await claim(alice, aliceWs);
    const retimed = await alice.client.from("voice_sessions").update({ started_at: new Date().toISOString(), max_seconds: 1 }).eq("id", session_id!).select("id");
    expect(retimed.error).not.toBeNull();
    const removed = await alice.client.from("voice_sessions").delete().eq("id", session_id!).select("id");
    expect(removed.data ?? []).toEqual([]);
    expect((await alice.client.from("voice_sessions").select("id").eq("id", session_id!)).data).toHaveLength(1);
  });

  it("take the provider's id once, from their own member only", async () => {
    const { session_id } = await claim(alice, aliceWs);
    const stolen = await bob.client.from("voice_sessions").update({ provider_conversation_id: "conv_bob" }).eq("id", session_id!).select("id");
    expect(stolen.data ?? []).toEqual([]);
    const own = await alice.client.from("voice_sessions").update({ provider_conversation_id: "conv_alice" }).eq("id", session_id!).select("provider_conversation_id");
    expect(own.data).toEqual([{ provider_conversation_id: "conv_alice" }]);
    const again = await alice.client.from("voice_sessions").update({ provider_conversation_id: "conv_other" }).eq("id", session_id!).select("id");
    expect(again.data ?? []).toEqual([]);
  });

  it("are ended only by their member, once, at the server's clock", async () => {
    const { session_id } = await claim(alice, aliceWs);
    expect((await bob.client.rpc("end_voice_session", { p_id: session_id })).data).toBeNull();
    expect((await teammate.client.rpc("end_voice_session", { p_id: session_id })).data).toBeNull();
    const ended = await alice.client.rpc("end_voice_session", { p_id: session_id });
    expect(ended.error).toBeNull();
    expect(typeof ended.data).toBe("number");
    expect((await alice.client.rpc("end_voice_session", { p_id: session_id })).data).toBeNull();
  });

  it("end the member's other open call when a new one starts", async () => {
    const first = await claim(alice, aliceWs);
    const second = await claim(alice, aliceWs);
    const rows = await alice.client.from("voice_sessions").select("id, ended_at").in("id", [first.session_id!, second.session_id!]);
    const byId = new Map((rows.data ?? []).map((r) => [r.id, r.ended_at]));
    expect(byId.get(first.session_id!)).not.toBeNull();
    expect(byId.get(second.session_id!)).toBeNull();
  });

  it("hold each person to their daily voice time, across their agents", async () => {
    const carol = await createAccount("voice-carol");
    const one = await createWorkspace(carol, "Carol one");
    const two = await createWorkspace(carol, "Carol two");
    const first = await claim(carol, one, 600, 600);
    expect(first.refused).toBeNull();
    // Ten minutes ago, for 580 seconds: 20 of the 600 are left, under the half minute a call needs.
    const admin = await serviceClient();
    const started = new Date(Date.now() - 600_000);
    const update = await admin
      .from("voice_sessions")
      .update({ started_at: started.toISOString(), ended_at: new Date(started.getTime() + 580_000).toISOString() })
      .eq("id", first.session_id!);
    expect(update.error).toBeNull();
    // Today's window starts at UTC midnight; skip the cap check in the first ten minutes of a day.
    if (new Date().getUTCHours() === 0 && new Date().getUTCMinutes() < 10) return;
    expect((await claim(carol, two, 600, 600)).refused).toBe("daily");
    // With more time allowed, the next call gets only what's left.
    const left = await claim(carol, two, 900, 600);
    expect(left.refused).toBeNull();
    expect(left.max_seconds).toBe(320);
  });
});

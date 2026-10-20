import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createAccount, createWorkspace, serviceClient, type TestAccount } from "./helpers";

// Voice calls are private to the member who made them: no other tenant or teammate sees or ends
// them, members can't write a call's timing themselves, and claim_voice holds each person to
// their daily voice time across all their agents. Speech outside calls (voice_clips) is charged
// to the same daily time, by claim_voice_clip only, once per clip a day, and never out of time
// an open call was granted. Deleting an agent gives none of the day's time back.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
let aliceWs: string;
let bobWs: string;

type Claim = { session_id: string | null; max_seconds: number; refused: string | null };
type ClipClaim = { clip_id: string | null; seconds: number; refused: string | null };

async function clip(account: TestAccount, ws: string, ref: string, seconds: number, daily = 1800, kind = "preview"): Promise<ClipClaim> {
  const { data, error } = await account.client.rpc("claim_voice_clip", { ws, p_kind: kind, p_ref: ref, p_seconds: seconds, p_daily_seconds: daily });
  if (error) throw error;
  return (data as ClipClaim[])[0];
}

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

describe("voice clips", () => {
  // Today's window starts at UTC midnight; skip the totals in the first ten minutes of a day.
  const nearMidnight = () => new Date().getUTCHours() === 0 && new Date().getUTCMinutes() < 10;

  it("are charged to the caller in an agent they belong to, once per clip a day", async () => {
    const first = await clip(alice, aliceWs, "preview:steady:v1", 7);
    expect(first).toMatchObject({ seconds: 7, refused: null });
    expect(first.clip_id).toBeTruthy();
    // A replay (another tab, the same note again) is already paid for.
    expect(await clip(alice, aliceWs, "preview:steady:v1", 7)).toEqual({ clip_id: first.clip_id, seconds: 0, refused: null });
    // The same name for another kind of clip is another clip.
    expect((await clip(alice, aliceWs, "preview:steady:v1", 7, 1800, "note")).seconds).toBe(7);
    const row = await alice.client.from("voice_clips").select("user_id, workspace_id, kind, ref, seconds").eq("id", first.clip_id!).single();
    expect(row.data).toEqual({ user_id: alice.userId, workspace_id: aliceWs, kind: "preview", ref: "preview:steady:v1", seconds: 7 });

    expect((await bob.client.rpc("claim_voice_clip", { ws: aliceWs, p_kind: "preview", p_ref: "x", p_seconds: 1, p_daily_seconds: 1800 })).error).not.toBeNull();
    expect((await alice.client.rpc("claim_voice_clip", { ws: aliceWs, p_kind: "song", p_ref: "x", p_seconds: 1, p_daily_seconds: 1800 })).error).not.toBeNull();
    expect((await alice.client.rpc("claim_voice_clip", { ws: aliceWs, p_kind: "note", p_ref: "", p_seconds: 1, p_daily_seconds: 1800 })).error).not.toBeNull();
    expect((await alice.client.rpc("claim_voice_clip", { ws: aliceWs, p_kind: "note", p_ref: "x", p_seconds: -1, p_daily_seconds: 1800 })).error).not.toBeNull();
    // No limit isn't no limit.
    expect((await alice.client.rpc("claim_voice_clip", { ws: aliceWs, p_kind: "note", p_ref: "x", p_seconds: 0, p_daily_seconds: null })).error).not.toBeNull();
    expect((await alice.client.rpc("claim_voice", { ws: aliceWs, p_provider: "mock", p_daily_seconds: null, p_call_seconds: 600 })).error).not.toBeNull();
    expect((await alice.client.rpc("claim_voice", { ws: aliceWs, p_provider: "mock", p_daily_seconds: 1800, p_call_seconds: null })).error).not.toBeNull();
  });

  it("are visible only to their member, and never written directly", async () => {
    expect((await alice.client.from("voice_clips").select("id")).data?.length).toBeGreaterThan(0);
    expect((await teammate.client.from("voice_clips").select("id")).data).toEqual([]);
    expect((await bob.client.from("voice_clips").select("id")).data).toEqual([]);
    const { clip_id } = await clip(alice, aliceWs, `note:${crypto.randomUUID()}`, 3, 1800, "note");
    expect((await bob.client.from("voice_clips").insert({ workspace_id: bobWs, kind: "note", ref: "forged", seconds: 0 })).error).not.toBeNull();
    expect((await alice.client.from("voice_clips").insert({ workspace_id: aliceWs, kind: "note", ref: "forged", seconds: 0 })).error).not.toBeNull();
    expect((await alice.client.from("voice_clips").update({ seconds: 0 }).eq("id", clip_id!).select("id")).error).not.toBeNull();
    const removed = await alice.client.from("voice_clips").delete().eq("id", clip_id!).select("id");
    expect(removed.data ?? []).toEqual([]);
    expect((await alice.client.from("voice_clips").select("seconds").eq("id", clip_id!)).data).toEqual([{ seconds: 3 }]);
  });

  it("share each person's daily voice time with their calls, across their agents", async () => {
    const dave = await createAccount("voice-dave");
    const one = await createWorkspace(dave, "Dave one");
    const two = await createWorkspace(dave, "Dave two");
    if (nearMidnight()) return;
    expect((await clip(dave, one, "transcribe:a", 500, 600, "transcribe")).refused).toBeNull();
    // 100 seconds left today: a call gets only that, in either agent.
    const call = await claim(dave, two, 600, 600);
    expect(call.refused).toBeNull();
    expect(call.max_seconds).toBe(100);
    // While the call is open, its 100 seconds are its own: a clip can't spend them, and is refused charging nothing.
    expect(await clip(dave, two, "note:b", 90, 600, "note")).toEqual({ clip_id: null, seconds: 0, refused: "daily" });
    expect((await dave.client.from("voice_clips").select("ref").eq("ref", "note:b")).data).toEqual([]);
    // Ended right away, it gives back what it didn't use, so a clip fits; one that doesn't is refused.
    expect((await dave.client.rpc("end_voice_session", { p_id: call.session_id })).error).toBeNull();
    expect((await clip(dave, two, "note:b", 90, 600, "note")).refused).toBeNull();
    expect(await clip(dave, one, "note:c", 30, 600, "note")).toEqual({ clip_id: null, seconds: 0, refused: "daily" });
    expect((await dave.client.from("voice_clips").select("ref").eq("ref", "note:c")).data).toEqual([]);
    // Under half a minute left: no call.
    expect((await claim(dave, one, 600, 600)).refused).toBe("daily");
    // A clip already paid for plays again even with no time left, charging nothing.
    expect(await clip(dave, two, "note:b", 90, 600, "note")).toMatchObject({ seconds: 0, refused: null });
    expect(await clip(dave, one, "transcribe:a", 500, 600, "transcribe")).toMatchObject({ seconds: 0, refused: null });
  });

  it("stay counted when the agent they were spent in is deleted", async () => {
    const erin = await createAccount("voice-erin");
    const kept = await createWorkspace(erin, "Erin kept");
    const throwaway = await createWorkspace(erin, "Erin throwaway");
    if (nearMidnight()) return;
    expect((await clip(erin, throwaway, "transcribe:a", 500, 600, "transcribe")).refused).toBeNull();
    const call = await claim(erin, throwaway, 600, 600);
    expect(call.max_seconds).toBe(100);
    expect((await erin.client.rpc("end_voice_session", { p_id: call.session_id })).error).toBeNull();

    // Its owner can delete an agent (and make another in its place).
    expect((await erin.client.from("workspaces").delete().eq("id", throwaway)).error).toBeNull();
    const admin = await serviceClient();
    expect((await admin.from("workspaces").select("id").eq("id", throwaway)).data).toEqual([]);
    expect((await admin.from("voice_clips").select("workspace_id, seconds").eq("user_id", erin.userId)).data).toEqual([{ workspace_id: null, seconds: 500 }]);
    expect((await admin.from("voice_sessions").select("workspace_id").eq("user_id", erin.userId)).data).toEqual([{ workspace_id: null }]);
    // Gone from view with the agent, but the day's time is still spent.
    expect((await erin.client.from("voice_clips").select("id")).data).toEqual([]);
    expect((await erin.client.from("voice_sessions").select("id")).data).toEqual([]);
    expect(await clip(erin, kept, "note:b", 120, 600, "note")).toEqual({ clip_id: null, seconds: 0, refused: "daily" });
    const next = await claim(erin, kept, 600, 600);
    expect(next.refused).toBeNull();
    expect(next.max_seconds).toBeLessThanOrEqual(100);
    expect(next.max_seconds).toBeGreaterThanOrEqual(98);
  });
});

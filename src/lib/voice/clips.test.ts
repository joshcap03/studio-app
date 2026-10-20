import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Tenant } from "@/lib/tenant-core";

type Claim = { kind: string; ref: string; seconds: number; spent: boolean };
const claims = vi.hoisted(() => ({ calls: [] as Claim[], refuse: false }));
const heard = vi.hoisted(() => ({ result: { text: "Find me three roles", seconds: 2 } as { text: string; seconds: number; mock?: true } }));

vi.mock("./index", () => ({
  MAX_CLIP_SECONDS: 3600,
  claimVoiceClip: vi.fn(async (_tenant: unknown, clip: Omit<Claim, "spent">, options?: { spent?: boolean }) => {
    const spent = options?.spent === true;
    claims.calls.push({ ...clip, spent });
    // Time already spent is never refused (claimVoiceClip charges it past the day's limit).
    return claims.refuse && !spent ? { ok: false, refused: "daily" } : { ok: true, charged: clip.seconds };
  }),
}));
vi.mock("./speech", async (original) => ({
  ...(await original<typeof import("./speech")>()),
  speak: vi.fn(async () => ({ audio: new Uint8Array([1, 2]), type: "audio/mpeg", mock: false })),
  transcribe: vi.fn(async () => heard.result),
}));

const { hearRecording, sayNote } = await import("./clips");
const speech = await import("./speech");

const tenant = {} as Tenant;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

beforeEach(() => {
  claims.calls = [];
  claims.refuse = false;
  heard.result = { text: "Find me three roles", seconds: 2 };
  vi.mocked(speech.speak).mockClear();
  vi.mocked(speech.transcribe).mockClear();
});

describe("a voice note", () => {
  it("is charged by how long its words take to say, before it's made", async () => {
    const note = { script: "Three roles cleared your bar. The best is remote.", source: "summary" as const };
    const said = await sayNote(tenant, "m1", note, "warm");
    expect(said).toMatchObject({ ok: true, speech: { type: "audio/mpeg" } });
    expect(speech.speak).toHaveBeenCalledWith(note.script, "warm");
    const [claim] = claims.calls;
    expect(claim).toMatchObject({ kind: "note", seconds: Math.ceil(note.script.length / 15), spent: false });
    // Named by the reply, a hash of what's said and in which voice, and the play; never the words.
    expect(claim.ref).toMatch(new RegExp(`^m1:[0-9a-f]{64}:${UUID}$`));
    expect(claim.ref).not.toContain("roles");
  });

  it("is charged again each time the voice makes it again, so no play is free", async () => {
    const note = { script: "Done.", source: "reply" as const };
    await sayNote(tenant, "m1", note, "warm");
    await sayNote(tenant, "m1", note, "warm");
    expect(speech.speak).toHaveBeenCalledTimes(2);
    expect(claims.calls).toHaveLength(2);
    expect(claims.calls.every((c) => c.seconds > 0)).toBe(true);
    expect(claims.calls[0].ref).not.toBe(claims.calls[1].ref);
  });

  it("isn't made once the day's voice time is used up", async () => {
    claims.refuse = true;
    expect(await sayNote(tenant, "m1", { script: "Hi.", source: "reply" }, "warm")).toEqual({ ok: false, refused: "daily" });
    expect(speech.speak).not.toHaveBeenCalled();
  });
});

describe("a recording", () => {
  it("is charged by its size before it's heard, and the rest once the provider says how long it ran", async () => {
    const audio = new Uint8Array(8000);
    expect(await hearRecording(tenant, audio, "audio/webm")).toEqual({ ok: true, text: "Find me three roles", mock: false });
    expect(claims.calls).toEqual([{ kind: "transcribe", ref: expect.stringMatching(new RegExp(`^[0-9a-f]{64}:${UUID}$`)), seconds: 2, spent: false }]);
    expect(speech.transcribe).toHaveBeenCalledWith(audio, "audio/webm");

    claims.calls = [];
    heard.result = { text: "A longer one", seconds: 40 };
    await hearRecording(tenant, new Uint8Array(8001), "audio/mp4");
    expect(claims.calls.map((c) => [c.seconds, c.spent])).toEqual([
      [3, false],
      [37, true],
    ]);
    expect(claims.calls[1].ref).toBe(`${claims.calls[0].ref}:rest:0`);
  });

  it("is heard, and charged, each time it's sent, even the same bytes again", async () => {
    const audio = new Uint8Array(4000).fill(7);
    heard.result = { text: "Again", seconds: 1 };
    await hearRecording(tenant, audio, "audio/webm");
    await hearRecording(tenant, audio, "audio/webm");
    expect(speech.transcribe).toHaveBeenCalledTimes(2);
    expect(claims.calls.map((c) => c.seconds)).toEqual([1, 1]);
    expect(claims.calls[0].ref).not.toBe(claims.calls[1].ref);
  });

  it("is charged no more than the mic's two minutes up front, the rest once it's heard", async () => {
    heard.result = { text: "Two minutes of it", seconds: 118 };
    await hearRecording(tenant, new Uint8Array(4 * 1024 * 1024), "audio/webm");
    expect(claims.calls.map((c) => [c.seconds, c.spent])).toEqual([[120, false]]);
  });

  it("past the mic's two minutes, gets no words back, and all the provider heard is charged, past the day's limit, in parts", async () => {
    heard.result = { text: "An hour and a half of it", seconds: 5400 };
    expect(await hearRecording(tenant, new Uint8Array(400_000), "audio/ogg")).toEqual({ ok: false, refused: "long" });
    expect(claims.calls.map((c) => [c.seconds, c.spent])).toEqual([
      [100, false],
      [3600, true],
      [1700, true],
    ]);
    expect(claims.calls.reduce((sum, c) => sum + c.seconds, 0)).toBe(5400);
    // A few seconds over is still the mic's own.
    claims.calls = [];
    heard.result = { text: "Just about two minutes", seconds: 124 };
    expect(await hearRecording(tenant, new Uint8Array(400_000), "audio/ogg")).toMatchObject({ ok: true, text: "Just about two minutes" });
  });

  it("past what's left of the day once heard, is charged in full, so nothing more is heard today", async () => {
    // The day had room for the size estimate; what the provider then heard is spent all the same.
    heard.result = { text: "Longer than its size said", seconds: 90 };
    expect(await hearRecording(tenant, new Uint8Array(40_000), "audio/webm")).toMatchObject({ ok: true });
    expect(claims.calls.map((c) => [c.seconds, c.spent])).toEqual([
      [10, false],
      [80, true],
    ]);
  });

  it("isn't heard once the day's voice time is used up", async () => {
    claims.refuse = true;
    expect(await hearRecording(tenant, new Uint8Array(100), "audio/webm")).toEqual({ ok: false, refused: "daily" });
    expect(speech.transcribe).not.toHaveBeenCalled();
  });

  it("gives no words back when the rest can't be charged", async () => {
    heard.result = { text: "Find me three roles", seconds: 30 };
    const { claimVoiceClip } = await import("./index");
    vi.mocked(claimVoiceClip).mockResolvedValueOnce({ ok: true, charged: 1 }).mockRejectedValueOnce(new Error("database down"));
    await expect(hearRecording(tenant, new Uint8Array(100), "audio/webm")).rejects.toThrow("database down");
  });

  it("says when the mock heard nothing", async () => {
    heard.result = { text: "", seconds: 0, mock: true };
    expect(await hearRecording(tenant, new Uint8Array(100), "audio/webm")).toEqual({ ok: true, text: "", mock: true });
    expect(claims.calls).toHaveLength(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Tenant } from "@/lib/tenant-core";

const secret = "s".repeat(40);
const config = vi.hoisted(() => ({
  voice: { provider: "mock", sealSecret: "s".repeat(40), limits: { secondsPerDay: 1800, callSeconds: 1500 } } as unknown,
  dictation: { provider: "mock", sealSecret: "s".repeat(40), secondsPerDay: 600 },
}));
vi.mock("@/lib/config", () => ({ getConfig: () => config }));

const { claimVoiceClip } = await import("./index");
const { clipKey } = await import("./seal");

function tenantWith(rows: unknown[]) {
  const rpc = vi.fn(async () => ({ data: rows, error: null }));
  return { rpc, tenant: { db: { rpc }, workspace: { id: "ws_1" } } as unknown as Tenant };
}

describe("claimVoiceClip", () => {
  it("charges a clip under a keyed name, never its plain one, against the app's own daily limit", async () => {
    const { rpc, tenant } = tenantWith([{ clip_id: "clip_1", seconds: 8, refused: null }]);
    expect(await claimVoiceClip(tenant, { kind: "preview", ref: "preview:warm:v1", seconds: 7.2 })).toEqual({ ok: true, charged: 8 });
    expect(rpc).toHaveBeenCalledWith("claim_voice_clip", {
      ws: "ws_1",
      p_kind: "preview",
      p_ref: clipKey("preview", "preview:warm:v1", secret),
      p_seconds: 8,
      p_daily_seconds: 1800,
    });
    const sent = (rpc.mock.calls[0] as unknown[])[1] as { p_ref: string };
    expect(sent.p_ref).not.toContain("preview:warm");
  });

  it("charges a recording against dictation's own limit, with the rest of voice out too", async () => {
    const { rpc, tenant } = tenantWith([{ clip_id: "clip_3", seconds: 5, refused: null }]);
    const voice = config.voice;
    config.voice = undefined;
    try {
      expect(await claimVoiceClip(tenant, { kind: "transcribe", ref: "r2", seconds: 5 })).toEqual({ ok: true, charged: 5 });
      expect(rpc).toHaveBeenCalledWith("claim_voice_clip", expect.objectContaining({ p_kind: "transcribe", p_ref: clipKey("transcribe", "r2", secret), p_daily_seconds: 600 }));
      await expect(claimVoiceClip(tenant, { kind: "note", ref: "m1", seconds: 3 })).rejects.toThrow("Voice isn't set up.");
    } finally {
      config.voice = voice;
    }
  });

  it("says when today's voice time is used up", async () => {
    const { tenant } = tenantWith([{ clip_id: null, seconds: 0, refused: "daily" }]);
    expect(await claimVoiceClip(tenant, { kind: "note", ref: "m1:abc", seconds: 3 })).toEqual({ ok: false, refused: "daily" });
  });

  it("charges time already spent past today's limit, and never more than one clip holds", async () => {
    const { rpc, tenant } = tenantWith([{ clip_id: "clip_2", seconds: 90, refused: null }]);
    expect(await claimVoiceClip(tenant, { kind: "transcribe", ref: "r1:rest", seconds: 90 }, { spent: true })).toEqual({ ok: true, charged: 90 });
    const sent = (rpc.mock.calls[0] as unknown[])[1] as { p_daily_seconds: number };
    // No limit the database can hold that a day's voice time could pass.
    expect(sent.p_daily_seconds).toBe(2 ** 31 - 1);
    await expect(claimVoiceClip(tenant, { kind: "transcribe", ref: "r1:rest", seconds: 3601 }, { spent: true })).rejects.toBeInstanceOf(RangeError);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

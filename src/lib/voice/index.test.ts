import { describe, expect, it, vi } from "vitest";
import type { Tenant } from "@/lib/tenant-core";

const secret = "s".repeat(40);
const config = vi.hoisted(() => ({ voice: { provider: "mock", sealSecret: "s".repeat(40), limits: { secondsPerDay: 1800, callSeconds: 1500 } } }));
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

  it("says when today's voice time is used up", async () => {
    const { tenant } = tenantWith([{ clip_id: null, seconds: 0, refused: "daily" }]);
    expect(await claimVoiceClip(tenant, { kind: "note", ref: "m1:abc", seconds: 3 })).toEqual({ ok: false, refused: "daily" });
  });
});

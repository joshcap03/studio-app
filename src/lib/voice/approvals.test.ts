import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredApproval } from "@/lib/db/store";
import type { Tenant } from "@/lib/tenant-core";

// The server's own checks on a decision said on a call. The config, the voice preview and the
// call lookup are stand-ins; everything else is the real module.

const config = vi.hoisted(() => ({
  voice: { provider: "mock", spokenApprovals: true } as { provider: string; spokenApprovals: boolean } | undefined,
  agent: { provider: "mock" } as { provider: string },
}));
const state = vi.hoisted(() => ({ voiceOn: true, call: { id: "call-1", startedAt: 0, endedAt: null } as { id: string; startedAt: number; endedAt: number | null } | null }));
vi.mock("@/lib/config", () => ({ getConfig: () => config }));
vi.mock("./status", () => ({ voiceStatus: () => (state.voiceOn ? { provider: "mock" } : null) }));
vi.mock("./calls", () => ({ openCall: vi.fn(async (_tenant: unknown, id: string) => (state.call && state.call.id === id ? state.call : null)) }));

const { checkSpokenDecision, reportSpokenApproval, spokenApprovalsOn } = await import("./approvals");

const CALL = "00000000-0000-4000-8000-000000000001";

function tenantWith(rpc: (name: string, args?: unknown) => { data: unknown; error: { message: string } | null }) {
  return { email: "m@example.test", db: { rpc: vi.fn(async (name: string, args?: unknown) => rpc(name, args)) }, workspace: { id: "ws_1" } } as unknown as Tenant;
}
const tripped = (off: boolean) => tenantWith((name) => (name === "spoken_approvals_off" ? { data: off, error: null } : { data: null, error: null }));

const approval = (spoken: StoredApproval["spoken"]): StoredApproval => ({
  id: "a1",
  summary: "Email Jo",
  details: [],
  status: "pending",
  createdAt: 0,
  conversationId: "c1",
  messageId: "m1",
  provider: "mock",
  providerState: {},
  spoken,
});
const voiceOk = approval({ ok: true, readBack: "I'll email jo@acme.example." });
const money = approval({ ok: false, reason: "money" });
const heard = (words: string, voiceSessionId = CALL) => ({ heard: words, voiceSessionId });

beforeEach(() => {
  config.voice = { provider: "mock", spokenApprovals: true };
  config.agent = { provider: "mock" };
  state.voiceOn = true;
  state.call = { id: CALL, startedAt: 0, endedAt: null };
});

describe("spokenApprovalsOn", () => {
  it("needs the switch, the member's voice, and the trip wire not tripped; and fails closed", async () => {
    expect(await spokenApprovalsOn(tripped(false))).toBe(true);
    expect(await spokenApprovalsOn(tripped(true))).toBe(false);
    expect(await spokenApprovalsOn(tenantWith(() => ({ data: null, error: { message: "function does not exist" } })))).toBe(false);
    expect(await spokenApprovalsOn(tenantWith(() => ({ data: null, error: null })))).toBe(false);
    config.voice = { provider: "mock", spokenApprovals: false };
    expect(await spokenApprovalsOn(tripped(false))).toBe(false);
    config.voice = undefined;
    expect(await spokenApprovalsOn(tripped(false))).toBe(false);
    config.voice = { provider: "mock", spokenApprovals: true };
    state.voiceOn = false;
    expect(await spokenApprovalsOn(tripped(false))).toBe(false);
  });

  it("is off when the mock voice, whose speech is typed, is in front of a real agent", async () => {
    config.agent = { provider: "langflow" };
    expect(await spokenApprovalsOn(tripped(false))).toBe(false);
    config.voice = { provider: "elevenlabs", spokenApprovals: true };
    expect(await spokenApprovalsOn(tripped(false))).toBe(true);
  });
});

describe("checkSpokenDecision", () => {
  it("lets a clear yes approve a voice-ok request on the member's open call", async () => {
    expect(await checkSpokenDecision(tripped(false), voiceOk, "approve", heard("send it"))).toBeNull();
    expect(await checkSpokenDecision(tripped(false), voiceOk, "approve", heard("Yes, go ahead"))).toBeNull();
  });

  it("refuses an approval that isn't voice-ok, isn't a clear yes, or comes while spoken approvals are off", async () => {
    expect(await checkSpokenDecision(tripped(false), money, "approve", heard("send it"))).toMatch(/tap/);
    expect(await checkSpokenDecision(tripped(false), approval(undefined), "approve", heard("send it"))).toMatch(/tap/);
    for (const words of ["yes", "okay", "send it to Sam", "send it?", "", "don't send it"]) {
      expect(await checkSpokenDecision(tripped(false), voiceOk, "approve", heard(words)), words).toMatch(/send it/);
    }
    expect(await checkSpokenDecision(tripped(true), voiceOk, "approve", heard("send it"))).toMatch(/taps for now/);
    config.voice = { provider: "mock", spokenApprovals: false };
    expect(await checkSpokenDecision(tripped(false), voiceOk, "approve", heard("send it"))).toMatch(/taps for now/);
    state.voiceOn = false;
    expect(await checkSpokenDecision(tripped(false), voiceOk, "approve", heard("send it"))).toMatch(/Calls are off/);
  });

  it("never lets the mock voice's typed words approve a real provider's request", async () => {
    const real: StoredApproval = { ...voiceOk, provider: "langflow" };
    expect(await checkSpokenDecision(tripped(false), real, "approve", heard("send it"))).toMatch(/tap/);
    config.agent = { provider: "langflow" };
    expect(await checkSpokenDecision(tripped(false), real, "approve", heard("send it"))).toMatch(/tap/);
    // A real voice may; declining stays open to the mock.
    config.voice = { provider: "elevenlabs", spokenApprovals: true };
    expect(await checkSpokenDecision(tripped(false), real, "approve", heard("send it"))).toBeNull();
    config.voice = { provider: "mock", spokenApprovals: true };
    expect(await checkSpokenDecision(tripped(false), real, "reject", heard("don't send it"))).toBeNull();
  });

  it("refuses a decision without the member's own open call", async () => {
    expect(await checkSpokenDecision(tripped(false), voiceOk, "approve", heard("send it", "00000000-0000-4000-8000-000000000002"))).toMatch(/call has ended/);
    expect(await checkSpokenDecision(tripped(false), voiceOk, "approve", heard("send it", "not-a-call"))).toMatch(/call has ended/);
    state.call = null;
    expect(await checkSpokenDecision(tripped(false), voiceOk, "approve", heard("send it"))).toMatch(/call has ended/);
  });

  it("lets a clear no decline any request, even with spoken approvals off", async () => {
    expect(await checkSpokenDecision(tripped(true), money, "reject", heard("Don't send it"))).toBeNull();
    expect(await checkSpokenDecision(tripped(false), money, "reject", heard("send it"))).toMatch(/no/);
    state.call = null;
    expect(await checkSpokenDecision(tripped(false), money, "reject", heard("decline"))).toMatch(/call has ended/);
  });
});

describe("reportSpokenApproval", () => {
  it("trips the wire for one of the member's spoken approvals, and says when it isn't one", async () => {
    const calls: unknown[] = [];
    const tenant = tenantWith((name, args) => {
      calls.push([name, args]);
      return { data: true, error: null };
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await reportSpokenApproval(tenant, "c1", "a1")).toBe(true);
    expect(calls).toEqual([["report_spoken_approval", { p_conversation: "c1", p_approval: "a1" }]]);
    expect(await reportSpokenApproval(tenantWith(() => ({ data: false, error: null })), "c1", "a1")).toBe(false);
    await expect(reportSpokenApproval(tenantWith(() => ({ data: null, error: { message: "boom" } })), "c1", "a1")).rejects.toThrow("boom");
    // Without calls, there's nothing of theirs to report, and the database isn't asked.
    state.voiceOn = false;
    const asked = tenantWith(() => ({ data: true, error: null }));
    expect(await reportSpokenApproval(asked, "c1", "a1")).toBe(false);
    expect((asked.db.rpc as unknown as { mock: { calls: unknown[] } }).mock.calls).toEqual([]);
    logged.mockRestore();
  });
});

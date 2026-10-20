import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb, createMemoryStore } from "@/test/memory-store";
import type { Tenant } from "@/lib/tenant-core";

// How buildTurnDeps says how a turn was asked: a new message by what the browser says it was
// (typed, held to the mic, on a call), and a retry, an edit, or a decision by how the member's
// latest message was said, whatever the browser sends. Everything around it is stubbed.

const scope = { workspaceId: "ws-a", userId: "user-a" };
const db = vi.hoisted(() => ({ current: null as unknown }));
const seen = vi.hoisted(() => ({ modality: [] as unknown[], skills: [] as unknown[], voice: true }));

vi.mock("@/lib/chat/store-for", () => ({ storeFor: () => db.current }));
vi.mock("@/lib/agent", () => ({ getAgentAdapter: () => ({ id: "mock", capabilities: { attachments: false } }) }));
vi.mock("@/lib/agent-files", () => ({ agentFilesForRun: async () => [], runFiles: () => [] }));
vi.mock("@/lib/attachments", () => ({ readAttachment: vi.fn() }));
vi.mock("@/lib/companion", () => ({ getCompanion: vi.fn(), refreshCompanion: vi.fn() }));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ agent: { idleTimeoutMs: 1000 } }) }));
vi.mock("@/lib/flags", () => ({ previewEnabled: () => false }));
vi.mock("@/lib/library", () => ({ fileArtifact: vi.fn() }));
vi.mock("@/lib/memory", () => ({ memoryEnabled: () => false, recallQuery: () => "", remember: vi.fn() }));
vi.mock("@/lib/memory-merge", () => ({ resolveMergeProposal: vi.fn() }));
vi.mock("@/lib/projects", () => ({ projectForRun: vi.fn() }));
vi.mock("@/lib/push", () => ({ notificationFor: vi.fn(), notify: vi.fn(), pushEnabled: () => false }));
vi.mock("@/lib/skills", () => ({
  getSkill: vi.fn(async (_t: unknown, id: string, options: unknown) => (seen.skills.push(options), { id, name: "Skill", instructions: "Do it." })),
}));
vi.mock("@/lib/tasks", () => ({ getTask: vi.fn() }));
vi.mock("@/lib/tasks/agent", () => ({ savePlanFromAgent: vi.fn(), saveRecordFromAgent: vi.fn() }));
vi.mock("@/lib/voice/persona", () => ({ resolvePersona: vi.fn() }));
vi.mock("@/lib/voice/status", () => ({ voiceStatus: () => (seen.voice ? { provider: "mock", label: "Mock voice", live: false, speech: { tts: true, stt: true } } : null) }));
vi.mock("@/lib/workspace", () => ({
  claimRun: vi.fn(),
  getSettings: vi.fn(),
  buildAgentContext: vi.fn(async (_t: unknown, _q: unknown, _c: unknown, modality: unknown) => (seen.modality.push(modality), {})),
}));

const { buildTurnDeps } = await import("./run");
const tenant = { workspace: { id: scope.workspaceId }, userId: scope.userId } as Tenant;

async function conversationWith(origin: unknown) {
  const store = createMemoryStore(scope, createMemoryDb());
  db.current = store;
  const id = crypto.randomUUID();
  await store.createConversation({ id, title: "Roles" });
  const base = { conversationId: id, status: "complete" as const, activity: [], artifacts: [] };
  await store.insertMessage({ ...base, id: crypto.randomUUID(), role: "user", content: "Find roles", origin: origin as never, skill: { id: "builtin:setup", name: "Setup" } });
  await store.insertMessage({ ...base, id: crypto.randomUUID(), role: "assistant", content: "Found two." });
  return id;
}

beforeEach(() => {
  seen.modality = [];
  seen.skills = [];
  seen.voice = true;
});

describe("buildTurnDeps", () => {
  it("labels a new message by how it was said, and tells the agent", async () => {
    const id = await conversationWith(null);
    const held = await buildTurnDeps(tenant, { conversationId: id, input: { kind: "send", text: "Honestly I'm drowning", modality: "voice_note" } });
    expect(held.request).toMatchObject({ kind: "send", origin: { kind: "voice", via: "note" } });
    const called = await buildTurnDeps(tenant, { conversationId: id, input: { kind: "send", text: "Remote only", modality: "call" } });
    expect(called.request).toMatchObject({ origin: { kind: "voice" } });
    const typed = await buildTurnDeps(tenant, { conversationId: id, input: { kind: "send", text: "Remote only" } });
    expect((typed.request as { origin?: unknown }).origin).toBeUndefined();
    expect(seen.modality).toEqual(["voice_note", "call", undefined]);
  });

  it("answers a retry, an edit, or a decision the way the member's latest message was said", async () => {
    for (const [origin, modality] of [
      [{ kind: "voice", via: "note" }, "voice_note"],
      [{ kind: "voice" }, "call"],
      [null, undefined],
    ] as const) {
      const id = await conversationWith(origin);
      const [user] = await (db.current as ReturnType<typeof createMemoryStore>).listMessages(id);
      seen.modality = [];
      await buildTurnDeps(tenant, { conversationId: id, input: { kind: "retry" } });
      await buildTurnDeps(tenant, { conversationId: id, input: { kind: "edit", messageId: user.id, text: "Find PM roles" } });
      await buildTurnDeps(tenant, { conversationId: id, input: { kind: "decide", approvalId: crypto.randomUUID(), decision: "approve" } });
      expect(seen.modality).toEqual([modality, modality, modality]);
    }
  });

  it("loads a call's skills for the call, and gives voice notes only to members with voice", async () => {
    const id = await conversationWith({ kind: "voice" });
    const { deps } = await buildTurnDeps(tenant, { conversationId: id, input: { kind: "retry" } });
    await deps.loadSkill?.("builtin:setup");
    expect(seen.skills).toEqual([{ call: true }]);
    expect(deps.voiceNotes).toBe(true);
    seen.voice = false;
    expect((await buildTurnDeps(tenant, { conversationId: id, input: { kind: "retry" } })).deps.voiceNotes).toBe(false);
  });

  it("saves a plan where the work keeps it, with its goal; a run started with the setup skill is the setup's", async () => {
    const { savePlanFromAgent } = await import("@/lib/tasks/agent");
    const { buildAgentContext } = await import("@/lib/workspace");
    const id = await conversationWith(null);
    const setup = await buildTurnDeps(tenant, { conversationId: id, input: { kind: "send", text: "", skillId: "builtin:setup" } });
    await setup.deps.savePlan?.([{ text: "x", status: "todo" }], "a setup you'd trust");
    expect(savePlanFromAgent).toHaveBeenLastCalledWith(tenant, id, [{ text: "x", status: "todo" }], "a setup you'd trust", { setup: true });
    // Its context is the setup's too, even before the setup is recorded as under way again.
    expect(buildAgentContext).toHaveBeenLastCalledWith(tenant, "", id, undefined, { setupRun: true });
    const plain = await buildTurnDeps(tenant, { conversationId: id, input: { kind: "send", text: "Find caterers" } });
    await plain.deps.savePlan?.([{ text: "y", status: "todo" }], undefined);
    expect(savePlanFromAgent).toHaveBeenLastCalledWith(tenant, id, [{ text: "y", status: "todo" }], undefined, { setup: false });
    expect(buildAgentContext).toHaveBeenLastCalledWith(tenant, "", id, undefined, { setupRun: false });
  });
});

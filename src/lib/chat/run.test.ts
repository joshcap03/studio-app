import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb, createMemoryStore } from "@/test/memory-store";
import type { Tenant } from "@/lib/tenant-core";

// How buildTurnDeps says how a turn was asked: a new message by what the browser says it was
// (typed, held to the mic, on a call), and a retry, an edit, or a decision by how the member's
// latest message was said, whatever the browser sends. Everything around it is stubbed.

const scope = { workspaceId: "ws-a", userId: "user-a" };
const db = vi.hoisted(() => ({ current: null as unknown }));
const seen = vi.hoisted(() => ({ modality: [] as unknown[], skills: [] as unknown[], voice: true, allowed: [] as string[], started: [] as unknown[] }));

vi.mock("@/lib/chat/store-for", () => ({ storeFor: () => db.current }));
vi.mock("@/lib/agent", () => ({ getAgentAdapter: () => ({ id: "mock", capabilities: { attachments: false } }) }));
vi.mock("@/lib/agent-files", () => ({ agentFilesForRun: async () => [], runFiles: () => [] }));
vi.mock("@/lib/attachments", () => ({ readAttachment: vi.fn() }));
vi.mock("@/lib/companion", () => ({ getCompanion: vi.fn(), refreshCompanion: vi.fn() }));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ agent: { idleTimeoutMs: 1000 } }) }));
vi.mock("@/lib/flags", () => ({ previewEnabled: () => false }));
vi.mock("@/lib/library", () => ({ fileArtifact: vi.fn() }));
vi.mock("@/lib/memory", () => ({ memoryEnabled: () => false, recallQuery: () => "", rememberReplacing: vi.fn() }));
vi.mock("@/lib/memory-merge", () => ({ resolveMergeProposal: vi.fn() }));
vi.mock("@/lib/projects", () => ({ projectForRun: vi.fn() }));
vi.mock("@/lib/push", () => ({ notificationFor: vi.fn(), notify: vi.fn(), pushEnabled: () => false }));
vi.mock("@/lib/skills", () => ({
  getSkill: vi.fn(async (_t: unknown, id: string, options: unknown) => (seen.skills.push(options), { id, name: "Skill", instructions: "Do it." })),
}));
const tasks = vi.hoisted(() => ({ forConversation: null as unknown, settledKept: [] as unknown[] }));
vi.mock("@/lib/tasks", () => ({
  getTask: vi.fn(),
  getTaskForConversation: vi.fn(async () => tasks.forConversation),
  settleWaitingRun: vi.fn(),
  settleKeptRun: vi.fn(async (_t: unknown, taskId: string, message: { id: string }) => tasks.settledKept.push([taskId, message.id])),
}));
vi.mock("@/lib/account", () => ({
  getAllowedActions: vi.fn(async () => seen.allowed),
  setAllowedAction: vi.fn(async (_t: unknown, kind: string) => (seen.allowed = [...new Set([...seen.allowed, kind])])),
}));
// A run carried on is started, not run: what it was asked is all that's checked.
vi.mock("@/lib/chat/turn", async (actual) => ({
  ...(await actual<typeof import("./turn")>()),
  startTurn: vi.fn(async (_deps: unknown, request: unknown) => (seen.started.push(request), new ReadableStream())),
}));
vi.mock("@/lib/tasks/agent", () => ({ savePlanFromAgent: vi.fn(), saveRecordFromAgent: vi.fn() }));
vi.mock("@/lib/voice/persona", () => ({ resolvePersona: vi.fn() }));
// Only "mine" is the member's own call in this agent, still going or just hung up on.
vi.mock("@/lib/voice/calls", () => ({
  callForWords: vi.fn(async (_t: unknown, id: string) => (id === MY_CALL ? { id, startedAt: 0, endedAt: null } : null)),
  callEnded: vi.fn(async () => true),
}));
vi.mock("@/lib/voice/status", () => ({ voiceStatus: () => (seen.voice ? { provider: "mock", label: "Mock voice", live: false, speech: { tts: true, stt: true } } : null) }));
vi.mock("@/lib/workspace", () => ({
  claimRun: vi.fn(),
  getSettings: vi.fn(),
  buildAgentContext: vi.fn(async (_t: unknown, _q: unknown, _c: unknown, modality: unknown) => (seen.modality.push(modality), {})),
}));

const MY_CALL = "11111111-1111-4111-8111-111111111111";
const THEIR_CALL = "22222222-2222-4222-8222-222222222222";

const { buildTurnDeps, standingCarryOn, MAX_STANDING } = await import("./run");
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
  seen.allowed = [];
  seen.started = [];
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

  it("ties words said on a call to the call only once it's the member's own", async () => {
    const id = await conversationWith(null);
    const mine = await buildTurnDeps(tenant, { conversationId: id, input: { kind: "send", text: "Remote only", modality: "call", voiceSessionId: MY_CALL } });
    expect(mine.request).toMatchObject({ origin: { kind: "voice", sessionId: MY_CALL } });
    // Someone else's call (or one long over) labels the words as spoken, and nothing more.
    const theirs = await buildTurnDeps(tenant, { conversationId: id, input: { kind: "send", text: "Remote only", modality: "call", voiceSessionId: THEIR_CALL } });
    expect((theirs.request as { origin?: unknown }).origin).toEqual({ kind: "voice" });
    // A call id on a typed message or a voice message means nothing.
    const typed = await buildTurnDeps(tenant, { conversationId: id, input: { kind: "send", text: "Remote only", voiceSessionId: MY_CALL } });
    expect((typed.request as { origin?: unknown }).origin).toBeUndefined();
    const held = await buildTurnDeps(tenant, { conversationId: id, input: { kind: "send", text: "Remote only", modality: "voice_note", voiceSessionId: MY_CALL } });
    expect((held.request as { origin?: unknown }).origin).toEqual({ kind: "voice", via: "note" });
    // Whether that call is over decides whether its reply comes back as a voice note.
    expect(await mine.deps.callEnded?.(MY_CALL)).toBe(true);
  });

  it("lets the agent offer a call only where the member could take one, on a page that can show it", async () => {
    const typed = await conversationWith(null);
    const offered = await buildTurnDeps(tenant, { conversationId: typed, input: { kind: "send", text: "Which offer should I take?", offers: true } });
    expect(offered.deps.offerCalls).toBe(true);
    expect(offered.deps.context.calls).toBe(true);
    expect(offered.request).not.toHaveProperty("offers");
    expect((await buildTurnDeps(tenant, { conversationId: typed, input: { kind: "retry", offers: true } })).deps.offerCalls).toBe(true);
    // A page from before offers (an open tab across a deploy) says nothing, and gets none: it would break on the card.
    const older = await buildTurnDeps(tenant, { conversationId: typed, input: { kind: "send", text: "Which offer should I take?" } });
    expect(older.deps.offerCalls).toBe(false);
    expect(older.deps.offersShown).toBe(false);
    expect(older.deps.context.calls).toBeUndefined();
    expect(offered.deps.offersShown).toBe(true);
    expect((await buildTurnDeps(tenant, { conversationId: typed, input: { kind: "retry" } })).deps.offerCalls).toBe(false);
    // A task's run streams to no page (its conversation loads without offers on a page from before them).
    const { getTask } = await import("@/lib/tasks");
    vi.mocked(getTask).mockResolvedValueOnce({ id: "t1", title: "Weekly roles", instructions: "Check for new roles.", skillId: null } as never);
    expect((await buildTurnDeps(tenant, { conversationId: typed, input: { kind: "task", taskId: "t1", runId: null } })).deps.offerCalls).toBe(true);
    // On a call, it's already talking.
    const onCall = await buildTurnDeps(tenant, { conversationId: typed, input: { kind: "send", text: "Which one?", modality: "call", offers: true } });
    expect(onCall.deps.offerCalls).toBe(false);
    expect(onCall.deps.context.calls).toBeUndefined();
    // They said Not now to an offer here: no more offers in this conversation.
    const store = db.current as ReturnType<typeof createMemoryStore>;
    const [, reply] = await store.listMessages(typed);
    await store.updateMessage(reply.id, { ui: [{ kind: "offer", id: "o1", reason: "Quicker to talk." }], uiResponse: { o1: { status: "declined", at: 1 } } });
    expect((await buildTurnDeps(tenant, { conversationId: typed, input: { kind: "send", text: "And now?", offers: true } })).deps.offerCalls).toBe(false);
    const decidedOnCall = await conversationWith({ kind: "voice" });
    expect((await buildTurnDeps(tenant, { conversationId: decidedOnCall, input: { kind: "decide", approvalId: crypto.randomUUID(), decision: "approve", offers: true } })).deps.offerCalls).toBe(false);
    // Without calls, never.
    seen.voice = false;
    const fresh = await conversationWith(null);
    expect((await buildTurnDeps(tenant, { conversationId: fresh, input: { kind: "send", text: "Which offer?", offers: true } })).deps.offerCalls).toBe(false);
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

  it("treats every run as typed for a member without voice, whatever the browser or an older message says", async () => {
    seen.voice = false;
    const id = await conversationWith(null);
    const called = await buildTurnDeps(tenant, { conversationId: id, input: { kind: "send", text: "Remote only", modality: "call", voiceSessionId: MY_CALL, offers: true } });
    expect((called.request as { origin?: unknown }).origin).toBeUndefined();
    expect(called.deps.offersShown).toBe(false);
    expect(called.deps.voice).toBe(false);
    const held = await buildTurnDeps(tenant, { conversationId: id, input: { kind: "send", text: "Remote only", modality: "voice_note" } });
    expect((held.request as { origin?: unknown }).origin).toBeUndefined();
    // A retry or decision under words said on a call, from when voice was on.
    const spoken = await conversationWith({ kind: "voice" });
    seen.modality = [];
    const { deps } = await buildTurnDeps(tenant, { conversationId: spoken, input: { kind: "retry" } });
    await buildTurnDeps(tenant, { conversationId: spoken, input: { kind: "decide", approvalId: crypto.randomUUID(), decision: "approve" } });
    expect(seen.modality).toEqual([undefined, undefined]);
    await deps.loadSkill?.("builtin:setup");
    expect(seen.skills).toEqual([{ call: false }]);
    seen.voice = true;
    expect((await buildTurnDeps(tenant, { conversationId: id, input: { kind: "send", text: "Remote only", offers: true } })).deps.voice).toBe(true);
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
    expect(buildAgentContext).toHaveBeenLastCalledWith(tenant, "", id, undefined, expect.objectContaining({ setupRun: true }));
    const plain = await buildTurnDeps(tenant, { conversationId: id, input: { kind: "send", text: "Find caterers" } });
    await plain.deps.savePlan?.([{ text: "y", status: "todo" }], undefined);
    expect(savePlanFromAgent).toHaveBeenLastCalledWith(tenant, id, [{ text: "y", status: "todo" }], undefined, { setup: false });
    expect(buildAgentContext).toHaveBeenLastCalledWith(tenant, "", id, undefined, expect.objectContaining({ setupRun: false }));
  });
});

describe("standing OKs", () => {
  /** A conversation whose latest reply waits on a request of `standing`'s kind (or another kind). */
  async function waitingOn(standing?: "gmail_labels") {
    const id = await conversationWith(null);
    const store = db.current as ReturnType<typeof createMemoryStore>;
    const reply = await store.insertMessage({ id: crypto.randomUUID(), conversationId: id, role: "assistant", content: "", status: "awaiting", activity: [], artifacts: [] });
    const approval = await store.createApproval({
      conversationId: id,
      messageId: reply.id,
      summary: "Label 3 threads Priority",
      details: [],
      provider: "mock",
      providerState: {},
      ...(standing ? { standing } : {}),
    });
    return { id, reply, approval };
  }
  const time = () => Date.now() + 200_000;

  it("come with every conversation, and a tap gives one to the person, for all their agents", async () => {
    seen.allowed = ["gmail_labels"];
    const id = await conversationWith(null);
    const { deps } = await buildTurnDeps(tenant, { conversationId: id, input: { kind: "send", text: "Sort my mail" } });
    expect(deps.standing?.allowed).toEqual(["gmail_labels"]);
    expect(deps.context.allowed).toEqual(["gmail_labels"]);
    seen.allowed = [];
    const fresh = await buildTurnDeps(tenant, { conversationId: id, input: { kind: "send", text: "Sort my mail" } });
    expect(fresh.deps.context.allowed).toBeUndefined();
    expect(await fresh.deps.standing!.grant("gmail_labels")).toBe(true);
    expect(seen.allowed).toEqual(["gmail_labels"]);
  });

  it("carry a chat on past a request the member OK'd for good, as the run, in the time left", async () => {
    seen.allowed = ["gmail_labels"];
    const { id, reply, approval } = await waitingOn("gmail_labels");
    expect(await standingCarryOn(tenant, id, reply, { standingLeft: MAX_STANDING, deadline: time(), pages: { offers: true } })).toBe(true);
    expect(seen.started).toEqual([{ conversationId: id, kind: "decide", approvalId: approval.id, decision: "approve", standing: "auto" }]);
  });

  it("leave everything else waiting on the member", async () => {
    const notOkd = await waitingOn("gmail_labels");
    expect(await standingCarryOn(tenant, notOkd.id, notOkd.reply, { standingLeft: MAX_STANDING, deadline: time() })).toBe(false);
    seen.allowed = ["gmail_labels"];
    const otherKind = await waitingOn();
    expect(await standingCarryOn(tenant, otherKind.id, otherKind.reply, { standingLeft: MAX_STANDING, deadline: time() })).toBe(false);
    const covered = await waitingOn("gmail_labels");
    expect(await standingCarryOn(tenant, covered.id, covered.reply, { standingLeft: 0, deadline: time() })).toBe(false);
    expect(await standingCarryOn(tenant, covered.id, covered.reply, { standingLeft: MAX_STANDING, deadline: Date.now() + 30_000 })).toBe(false);
    expect(await standingCarryOn(tenant, covered.id, { ...covered.reply, status: "complete" }, { standingLeft: MAX_STANDING, deadline: time() })).toBe(false);
    expect(seen.started).toEqual([]);
  });
});

describe("a task's run carried on from the member's page", () => {
  it("goes on, or ends, with the reply that carried it on, and says nothing while it carries on", async () => {
    tasks.forConversation = { id: "t1", allowedActions: [] };
    tasks.settledKept = [];
    try {
      const id = await conversationWith({ kind: "task", taskId: "t1", title: "Sort mail", runId: null });
      const { deps } = await buildTurnDeps(tenant, { conversationId: id, input: { kind: "continue" } });
      const reply = { id: "m-next", conversationId: id, role: "assistant" as const, content: "Done.", status: "complete" as const, activity: [], artifacts: [], createdAt: 0 };
      await deps.onFinished!(reply, { id, title: "Sort mail", projectId: null, createdAt: 0, updatedAt: 0 }, { watched: false, report: null });
      expect(tasks.settledKept).toEqual([["t1", "m-next"]]);
    } finally {
      tasks.forConversation = null;
    }
  });
});

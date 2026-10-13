import { describe, expect, it } from "vitest";
import { createMockAdapter } from "@/lib/agent/mock";
import { AgentError, type AgentAdapter, type AgentEvent, type AgentRunInput, type AgentTenantContext } from "@/lib/agent/types";
import { readNdjson } from "@/lib/client/api";
import { createMemoryDb, createMemoryStore } from "@/test/memory-store";
import type { StreamEvent } from "@/lib/types";
import { sanitizeArtifact, startTurn, stopRun, titleFromMessage, TurnError } from "./turn";

const scopeA = { workspaceId: "ws-a", userId: "user-a" };
const scopeB = { workspaceId: "ws-b", userId: "user-b" };

function context(scope: { workspaceId: string; userId: string }): AgentTenantContext {
  return {
    workspaceId: scope.workspaceId,
    workspaceName: `Workspace ${scope.workspaceId}`,
    userId: scope.userId,
    composioUserId: `composio-${scope.userId}`,
    businessContext: `context for ${scope.workspaceId}`,
    agentInstructions: "",
    memories: [],
  };
}

const caps = {
  streaming: true,
  cancellation: "abort",
  toolEvents: true,
  artifacts: true,
  runStatus: false,
  approvals: true,
  attachments: true,
  rewind: false,
} as const;

function scripted(events: AgentEvent[], fail?: AgentError, seen?: AgentRunInput[]): AgentAdapter {
  return {
    id: "scripted",
    live: true,
    label: "Scripted",
    capabilities: caps,
    async *run(input) {
      seen?.push(input);
      for (const e of events) yield e;
      if (fail) throw fail;
    },
  };
}

async function collect(stream: Promise<ReadableStream<Uint8Array>>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  await readNdjson<StreamEvent>(await stream, (e) => events.push(e));
  return events;
}

const signal = () => new AbortController().signal;

describe("startTurn", () => {
  it("streams and persists a complete turn, creating the conversation", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const adapter = scripted([
      { type: "thread", threadId: "t-1" },
      { type: "activity", id: "a", label: "Reading", status: "running" },
      { type: "activity", id: "a", label: "Read", status: "done" },
      { type: "text-delta", text: "Hello " },
      { type: "text-delta", text: "there" },
      { type: "artifact", artifact: { id: "x", kind: "spreadsheet", title: "Sheet", url: "https://example.com/s" } },
    ]);
    const events = await collect(
      startTurn({ store, adapter, context: context(scopeA), idleTimeoutMs: 1000 }, { conversationId: id, kind: "send", text: "Hi" }),
    );
    expect(events[0].type).toBe("start");
    const end = events.at(-1);
    if (end?.type !== "end") throw new Error("no end event");
    expect(end.message).toMatchObject({ status: "complete", content: "Hello there" });
    expect(end.message.activity).toEqual([expect.objectContaining({ label: "Read", status: "done" })]);

    const saved = await store.listMessages(id);
    expect(saved.map((m) => [m.role, m.content, m.status])).toEqual([
      ["user", "Hi", "complete"],
      ["assistant", "Hello there", "complete"],
    ]);
    expect(saved[1].artifacts[0].title).toBe("Sheet");
    expect(await store.getConversation(id)).toMatchObject({ title: "Hi", agentProvider: "scripted", agentThreadId: "t-1" });
  });

  it("gives the adapter the caller's tenant context, thread id, and prior turns", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const seen: AgentRunInput[] = [];
    const adapter: AgentAdapter = {
      ...scripted([]),
      async *run(input) {
        seen.push(input);
        yield { type: "thread", threadId: "t-9" };
        yield { type: "message", text: `echo ${input.message}` };
      },
    };
    const deps = { store, adapter, context: context(scopeA), idleTimeoutMs: 1000 };
    await collect(startTurn(deps, { conversationId: id, kind: "send", text: "one" }));
    await collect(startTurn(deps, { conversationId: id, kind: "send", text: "two" }));

    expect(seen[0]).toMatchObject({ conversationId: id, threadId: null, history: [] });
    expect(seen[0].tenant).toEqual(context(scopeA));
    expect(seen[1]).toMatchObject({
      threadId: "t-9",
      history: [
        { role: "user", content: "one" },
        { role: "assistant", content: "echo one" },
      ],
    });
  });

  it("sends a skill's instructions with the message, but stores only the user's words", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const seen: AgentRunInput[] = [];
    const skill = { id: "skill-1", name: "Weekly sales report", instructions: "1. Pull orders." };
    const deps = {
      store,
      adapter: scripted([{ type: "message", text: "Done" }], undefined, seen),
      context: context(scopeA),
      idleTimeoutMs: 1000,
      loadSkill: async () => skill,
    };
    await collect(startTurn(deps, { conversationId: id, kind: "send", text: "", skill }));
    expect(seen[0].message).toContain("1. Pull orders.");
    const [user] = await store.listMessages(id);
    expect(user).toMatchObject({ content: "", skill: { id: "skill-1", name: "Weekly sales report" } });
    expect(await store.getConversation(id)).toMatchObject({ title: "Weekly sales report" });

    // Retry uses the skill's current instructions.
    skill.instructions = "1. Pull orders, edited.";
    await collect(startTurn(deps, { conversationId: id, kind: "retry" }));
    expect(seen[1].message).toContain("1. Pull orders, edited.");
  });

  it("refuses to retry a message whose skill was removed, keeping the reply", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const skill = { id: "skill-1", name: "Gone", instructions: "x" };
    const base = { store, adapter: scripted([{ type: "message", text: "Done" }]), context: context(scopeA), idleTimeoutMs: 1000 };
    await collect(startTurn(base, { conversationId: id, kind: "send", text: "hi", skill }));
    await expect(startTurn({ ...base, loadSkill: async () => null }, { conversationId: id, kind: "retry" })).rejects.toThrow(
      'The skill "Gone" was removed',
    );
    expect((await store.listMessages(id)).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("keeps a message's skill when it's edited", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const seen: AgentRunInput[] = [];
    const skill = { id: "skill-1", name: "Weekly sales report", instructions: "1. Pull orders." };
    const deps = {
      store,
      adapter: scripted([{ type: "message", text: "Done" }], undefined, seen),
      context: context(scopeA),
      idleTimeoutMs: 1000,
      loadSkill: async () => skill,
    };
    await collect(startTurn(deps, { conversationId: id, kind: "send", text: "for March", skill }));
    const userId = (await store.listMessages(id))[0].id;
    await collect(startTurn(deps, { conversationId: id, kind: "edit", messageId: userId, text: "for April" }));
    expect(seen[1].message).toContain("1. Pull orders.");
    expect(seen[1].message).toContain("for April");
    expect((await store.listMessages(id))[0]).toMatchObject({ content: "for April", skill: { id: "skill-1" } });
  });

  it("does not reuse a thread id recorded by a different provider", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    await store.createConversation({ id, title: "t" });
    await store.setAgentThread(id, "other-provider", "foreign-thread");
    const seen: AgentRunInput[] = [];
    await collect(
      startTurn(
        { store, adapter: scripted([{ type: "message", text: "ok" }], undefined, seen), context: context(scopeA), idleTimeoutMs: 1000 },
        { conversationId: id, kind: "send", text: "hi" }),
    );
    expect(seen[0].threadId).toBeNull();
  });

  it("records an agent failure with its user-safe message, and retry replaces it", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const failing = scripted([{ type: "text-delta", text: "partial" }], new AgentError("Shopify timed out."));
    const events = await collect(
      startTurn({ store, adapter: failing, context: context(scopeA), idleTimeoutMs: 1000 }, { conversationId: id, kind: "send", text: "go" }),
    );
    const end = events.at(-1);
    expect(end?.type === "end" && end.message).toMatchObject({ status: "error", error: "Shopify timed out." });

    const ok = scripted([{ type: "message", text: "worked" }]);
    await collect(startTurn({ store, adapter: ok, context: context(scopeA), idleTimeoutMs: 1000 }, { conversationId: id, kind: "retry" }));
    expect((await store.listMessages(id)).map((m) => [m.role, m.content, m.status])).toEqual([
      ["user", "go", "complete"],
      ["assistant", "worked", "complete"],
    ]);
  });

  it("retries a finished reply by replacing it", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const deps = (text: string) => ({ store, adapter: scripted([{ type: "message", text }]), context: context(scopeA), idleTimeoutMs: 1000 });
    await collect(startTurn(deps("first answer"), { conversationId: id, kind: "send", text: "question" }));
    await collect(startTurn(deps("second answer"), { conversationId: id, kind: "retry" }));
    expect((await store.listMessages(id)).map((m) => m.content)).toEqual(["question", "second answer"]);
  });

  it("fails a run that goes quiet past the idle timeout", async () => {
    const store = createMemoryStore(scopeA);
    const hanging: AgentAdapter = {
      ...scripted([]),
      async *run({ signal }) {
        yield { type: "text-delta", text: "…" };
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      },
    };
    const events = await collect(
      startTurn({ store, adapter: hanging, context: context(scopeA), idleTimeoutMs: 30 }, { conversationId: crypto.randomUUID(), kind: "send", text: "go" }),
    );
    const end = events.at(-1);
    expect(end?.type === "end" && end.message.error).toMatch(/stopped responding/);
  });

  it("stops only when asked, keeping partial text", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const stream = await startTurn(
      { store, adapter: createMockAdapter({ streaming: true, pace: 1 }), context: context(scopeA), idleTimeoutMs: 5000, checkpointMs: 0 },
      { conversationId: id, kind: "send", text: "help with operations" },
    );
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes('"type":"text"')) seen += decoder.decode((await reader.read()).value);
    expect(stopRun(scopeA.workspaceId, id)).toBe(true);
    while (!(await reader.read()).done) {
      // drain until the run closes the stream
    }
    const assistant = (await store.listMessages(id))[1];
    expect(assistant.status).toBe("stopped");
    expect(assistant.content.length).toBeGreaterThan(0);
  });

  it("keeps working after the browser disconnects, and saves the full reply", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const stream = await startTurn(
      { store, adapter: createMockAdapter({ streaming: true, pace: 0.2 }), context: context(scopeA), idleTimeoutMs: 5000 },
      { conversationId: id, kind: "send", text: "help with operations" },
    );
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel(); // tab closed
    for (let i = 0; i < 100 && (await store.listMessages(id))[1]?.status === "streaming"; i++) await new Promise((r) => setTimeout(r, 50));
    const assistant = (await store.listMessages(id))[1];
    expect(assistant.status).toBe("complete");
    expect(assistant.content).toContain("Happy to help");
  });

  it("refuses a second concurrent run in the same conversation", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const deps = { store, adapter: createMockAdapter({ streaming: true }), context: context(scopeA), idleTimeoutMs: 5000 };
    const stream = await startTurn(deps, { conversationId: id, kind: "send", text: "hello" });
    await expect(startTurn(deps, { conversationId: id, kind: "send", text: "again" })).rejects.toBeInstanceOf(TurnError);
    stopRun(scopeA.workspaceId, id);
    await stream.cancel();
  });

  it("keeps tenants apart even when one guesses another's conversation id", async () => {
    const db = createMemoryDb();
    const storeA = createMemoryStore(scopeA, db);
    const storeB = createMemoryStore(scopeB, db);
    const id = crypto.randomUUID();
    await collect(
      startTurn({ store: storeA, adapter: scripted([{ type: "message", text: "secret" }]), context: context(scopeA), idleTimeoutMs: 1000 }, { conversationId: id, kind: "send", text: "mine" }),
    );
    await expect(
      startTurn({ store: storeB, adapter: scripted([]), context: context(scopeB), idleTimeoutMs: 1000 }, { conversationId: id, kind: "retry" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      startTurn({ store: storeB, adapter: scripted([]), context: context(scopeB), idleTimeoutMs: 1000 }, { conversationId: id, kind: "send", text: "x" }),
    ).rejects.toThrow();
    expect(await storeB.listMessages(id)).toEqual([]);
    expect(await storeB.listConversations()).toEqual([]);
    expect((await storeA.listMessages(id)).map((m) => m.content)).toEqual(["mine", "secret"]);
  });
});

describe("approvals", () => {
  const paused: AgentEvent[] = [
    { type: "activity", id: "find", label: "Found the thread", status: "done", app: "gmail" },
    { type: "approval", summary: "Send the reply to Jo", app: "gmail", details: [["To", "jo@acme.example"]], state: { jobId: "job-1", requestId: "r-1" } },
  ];

  /** An adapter that pauses on a fresh run and finishes (or fails) when resumed. */
  function pausing(seen: AgentRunInput[], onResume: AgentEvent[] | AgentError = [{ type: "text-delta", text: "Sent it." }]): AgentAdapter {
    return {
      ...scripted([]),
      discard: async () => {},
      async *run(input) {
        seen.push(input);
        if (!input.resume) {
          yield* paused;
          return;
        }
        if (onResume instanceof AgentError) throw onResume;
        yield* onResume;
      },
    };
  }

  async function pause(store = createMemoryStore(scopeA), seen: AgentRunInput[] = [], adapter = pausing(seen)) {
    const id = crypto.randomUUID();
    const deps = { store, adapter, context: context(scopeA), idleTimeoutMs: 1000 };
    const events = await collect(startTurn(deps, { conversationId: id, kind: "send", text: "Email Jo" }));
    const approval = events.find((e) => e.type === "approval");
    if (approval?.type !== "approval") throw new Error("no approval");
    return { id, deps, events, approval: approval.approval, store, seen };
  }

  it("pauses the reply until the member answers, keeping what the agent did so far", async () => {
    const { id, events, approval, store } = await pause();
    expect(approval).toMatchObject({ summary: "Send the reply to Jo", app: "gmail", status: "pending", details: [["To", "jo@acme.example"]] });
    expect(JSON.stringify(events)).not.toContain("job-1"); // provider state never reaches the browser
    const [, reply] = await store.listMessages(id);
    expect(reply.status).toBe("awaiting");
    expect(reply.activity.map((s) => s.label)).toEqual(["Found the thread"]);
    expect(reply.approvals).toEqual([expect.objectContaining({ id: approval.id, status: "pending" })]);
    expect(JSON.stringify(reply)).not.toContain("job-1");
  });

  it("continues the same reply with the member's decision and the provider's state", async () => {
    const { id, deps, approval, store, seen } = await pause();
    const events = await collect(startTurn(deps, { conversationId: id, kind: "decide", approvalId: approval.id, decision: "approve" }));
    expect(seen[1].resume).toEqual({ decision: "approve", state: { jobId: "job-1", requestId: "r-1" } });
    const end = events.at(-1);
    expect(end?.type === "end" && end.message).toMatchObject({ status: "complete", content: "Sent it." });
    const messages = await store.listMessages(id);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ status: "complete", content: "Sent it.", approvals: [expect.objectContaining({ status: "approved" })] });
    expect(messages[1].activity.map((s) => s.label)).toEqual(["Found the thread"]);
  });

  describe("the step the run paused on", () => {
    const connecting: AgentEvent = { type: "activity", id: "msg-1:2", label: "Connecting Gmail", status: "running", app: "gmail", action: "connect" };
    const pausedOnStep: AgentEvent[] = [connecting, { type: "approval", summary: "Connect Gmail", app: "gmail", details: [], state: { jobId: "job-1", requestId: "r-1" } }];

    function pausingOn(onResume: AgentEvent[]): AgentAdapter {
      return {
        ...scripted([]),
        discard: async () => {},
        async *run(input) {
          yield* input.resume ? onResume : pausedOnStep;
        },
      };
    }

    async function decide(onResume: AgentEvent[], decision: "approve" | "reject") {
      const { id, deps, approval, store } = await pause(createMemoryStore(scopeA), [], pausingOn(onResume));
      const events = await collect(startTurn(deps, { conversationId: id, kind: "decide", approvalId: approval.id, decision }));
      const end = events.at(-1);
      if (end?.type !== "end") throw new Error("no end");
      return { end: end.message, saved: (await store.listMessages(id))[1] };
    }

    it("is settled by the resumed call, with no second step", async () => {
      const { end, saved } = await decide(
        [{ ...connecting, label: "Got a link to connect Gmail", status: "done" } as AgentEvent, { type: "text-delta", text: "Here's the link." }],
        "approve",
      );
      for (const message of [end, saved]) {
        expect(message.activity).toEqual([expect.objectContaining({ id: "msg-1:2", label: "Got a link to connect Gmail", status: "done", endedAt: expect.any(Number) })]);
      }
    });

    it("is settled when the approved run finishes without reporting it again", async () => {
      const { end, saved } = await decide([{ type: "text-delta", text: "Connected." }], "approve");
      for (const message of [end, saved]) expect(message.activity).toEqual([expect.objectContaining({ id: "msg-1:2", status: "done", endedAt: expect.any(Number) })]);
    });

    it("fails when the member declined it", async () => {
      const { end } = await decide([{ type: "text-delta", text: "Okay, I won't." }], "reject");
      expect(end.activity).toEqual([expect.objectContaining({ id: "msg-1:2", status: "failed", detail: "You declined this." })]);
    });
  });

  it("answers each request once", async () => {
    const { id, deps, approval } = await pause();
    await collect(startTurn(deps, { conversationId: id, kind: "decide", approvalId: approval.id, decision: "reject" }));
    await expect(startTurn(deps, { conversationId: id, kind: "decide", approvalId: approval.id, decision: "approve" })).rejects.toMatchObject({ status: 409 });
  });

  it("holds new messages until the request is answered", async () => {
    const { id, deps } = await pause();
    await expect(startTurn(deps, { conversationId: id, kind: "send", text: "hello?" })).rejects.toMatchObject({ status: 409 });
  });

  it("marks a request expired when the provider can no longer continue it", async () => {
    const seen: AgentRunInput[] = [];
    const { id, deps, approval, store } = await pause(createMemoryStore(scopeA), seen, pausing(seen, new AgentError("Expired.", { code: "expired" })));
    const events = await collect(startTurn(deps, { conversationId: id, kind: "decide", approvalId: approval.id, decision: "approve" }));
    const end = events.at(-1);
    expect(end?.type === "end" && end.message).toMatchObject({ status: "error", error: "Expired.", approvals: [expect.objectContaining({ status: "expired" })] });
    expect((await store.listMessages(id))[1].approvals?.[0].status).toBe("expired");
  });

  it("abandons the paused run when the member retries instead", async () => {
    const seen: AgentRunInput[] = [];
    const discarded: unknown[] = [];
    const adapter = { ...pausing(seen), discard: async (state: unknown) => void discarded.push(state) };
    const { id, deps, approval, store } = await pause(createMemoryStore(scopeA), seen, adapter);
    await collect(startTurn(deps, { conversationId: id, kind: "retry" }));
    expect(discarded).toEqual([{ jobId: "job-1", requestId: "r-1" }]);
    expect(await store.getApproval(approval.id)).toBeNull(); // went with the replaced reply
    await expect(startTurn(deps, { conversationId: id, kind: "decide", approvalId: approval.id, decision: "approve" })).rejects.toMatchObject({ status: 409 });
  });

  it("won't let another tenant answer a request", async () => {
    const db = createMemoryDb();
    const { id, approval } = await pause(createMemoryStore(scopeA, db));
    const storeB = createMemoryStore(scopeB, db);
    await expect(
      startTurn({ store: storeB, adapter: pausing([]), context: context(scopeB), idleTimeoutMs: 1000 }, { conversationId: id, kind: "decide", approvalId: approval.id, decision: "approve" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await storeB.getApproval(approval.id)).toBeNull();
  });
});

describe("edits, files, and memory suggestions", () => {
  it("edits the latest message, replaces its reply, and rewinds the provider", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const rewound: number[] = [];
    const seen: AgentRunInput[] = [];
    const adapter: AgentAdapter = {
      ...scripted([]),
      capabilities: { ...caps, rewind: true },
      rewind: async (_input, turns) => void rewound.push(turns),
      async *run(input) {
        seen.push(input);
        yield { type: "message", text: `re: ${input.message}` };
      },
    };
    const deps = { store, adapter, context: context(scopeA), idleTimeoutMs: 1000 };
    await collect(startTurn(deps, { conversationId: id, kind: "send", text: "first" }));
    await collect(startTurn(deps, { conversationId: id, kind: "send", text: "secnd" }));
    const userId = (await store.listMessages(id))[2].id;
    const events = await collect(startTurn(deps, { conversationId: id, kind: "edit", messageId: userId, text: "second" }));
    expect(events[0]).toMatchObject({ type: "start", userMessage: { id: userId, content: "second" } });
    expect((await store.listMessages(id)).map((m) => m.content)).toEqual(["first", "re: first", "second", "re: second"]);
    expect(rewound).toEqual([1]);
    expect(seen.at(-1)).toMatchObject({ message: "second", history: [{ content: "first" }, { content: "re: first" }] });

    const firstId = (await store.listMessages(id))[0].id;
    await expect(startTurn(deps, { conversationId: id, kind: "edit", messageId: firstId, text: "nope" })).rejects.toMatchObject({ status: 409 });
  });

  it("gives the agent the files sent with the message, and only those", async () => {
    const db = createMemoryDb();
    const store = createMemoryStore(scopeA, db);
    const add = (id: string, owner = scopeA) =>
      db.attachments.push({ id, name: `${id}.csv`, mimeType: "text/csv", size: 3, storagePath: `${owner.workspaceId}/${owner.userId}/${id}`, messageId: null, ...owner });
    add("f1");
    add("f2");
    add("theirs", scopeB);
    const seen: AgentRunInput[] = [];
    const deps = {
      store,
      adapter: scripted([{ type: "message", text: "read" }], undefined, seen),
      context: context(scopeA),
      idleTimeoutMs: 1000,
      loadAttachment: async (a: { storagePath: string }) => new Blob([a.storagePath]),
    };
    const id = crypto.randomUUID();
    const events = await collect(startTurn(deps, { conversationId: id, kind: "send", text: "see file", attachmentIds: ["f1"] }));
    expect(events[0]).toMatchObject({ type: "start", userMessage: { attachments: [{ id: "f1", name: "f1.csv" }] } });
    expect(seen[0].attachments.map((a) => a.name)).toEqual(["f1.csv"]);
    expect(await (await seen[0].attachments[0].read()).text()).toBe("ws-a/user-a/f1");
    expect((await store.listMessages(id))[0].attachments).toEqual([{ id: "f1", name: "f1.csv", mimeType: "text/csv", size: 3 }]);

    // Someone else's file, or one already sent, can't be attached; nothing is half-sent.
    for (const ids of [["theirs"], ["f1"], ["f2", "missing"]]) {
      await expect(startTurn(deps, { conversationId: id, kind: "send", text: "again", attachmentIds: ids })).rejects.toMatchObject({ status: 400 });
    }
    expect((await store.listMessages(id)).map((m) => m.content)).toEqual(["see file", "read"]);

    // A new conversation whose first send fails leaves nothing behind.
    const fresh = crypto.randomUUID();
    await expect(startTurn(deps, { conversationId: fresh, kind: "send", text: "x", attachmentIds: ["theirs"] })).rejects.toMatchObject({ status: 400 });
    expect(await store.getConversation(fresh)).toBeNull();
  });

  it("refuses files when the agent can't read them", async () => {
    const store = createMemoryStore(scopeA);
    const adapter = { ...scripted([]), capabilities: { ...caps, attachments: false } };
    await expect(
      startTurn({ store, adapter, context: context(scopeA), idleTimeoutMs: 1000 }, { conversationId: crypto.randomUUID(), kind: "send", text: "x", attachmentIds: ["f1"] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("keeps the agent's memory suggestions on the reply, pending, without saving them", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const adapter = scripted([
      { type: "memory-proposal", content: "  Fiscal year starts in   February ", scope: "workspace" },
      { type: "memory-proposal", content: "Fiscal year starts in February", scope: "workspace" },
      { type: "message", text: "Noted." },
    ]);
    const events = await collect(startTurn({ store, adapter, context: context(scopeA), idleTimeoutMs: 1000 }, { conversationId: id, kind: "send", text: "fy?" }));
    expect(events.filter((e) => e.type === "memory-proposal")).toHaveLength(1);
    const reply = (await store.listMessages(id))[1];
    expect(reply.memoryProposals).toEqual([{ id: expect.any(String), content: "Fiscal year starts in February", scope: "workspace", status: "pending" }]);
  });
});

describe("mock adapter", () => {
  it("emits a single message in non-streaming mode", async () => {
    const adapter = createMockAdapter({ streaming: false, pace: 0 });
    const events: AgentEvent[] = [];
    for await (const e of adapter.run({ conversationId: "c", threadId: null, message: "help", history: [], tenant: context(scopeA), attachments: [], signal: signal() }))
      events.push(e);
    expect(events.filter((e) => e.type === "text-delta")).toHaveLength(0);
    expect(events.filter((e) => e.type === "message")).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("drops artifacts without a safe https url", () => {
    expect(sanitizeArtifact({ id: "1", kind: "document", title: "Doc", url: "javascript:alert(1)" })).toEqual({
      id: "1",
      kind: "document",
      title: "Doc",
      url: undefined,
    });
    expect(sanitizeArtifact({ id: "1", kind: "unknown-kind", title: "F" })?.kind).toBe("file");
    expect(sanitizeArtifact({ kind: "document" })).toBeNull();
  });

  it("builds short titles", () => {
    expect(titleFromMessage("  Hello\n world ")).toBe("Hello world");
    const long = titleFromMessage("word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith("…")).toBe(true);
  });
});

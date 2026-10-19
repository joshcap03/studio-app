import { describe, expect, it, vi } from "vitest";
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
    composioToolkits: {},
    profile: `context for ${scope.workspaceId}`,
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

  it("doesn't show a reply twice when the adapter first took it for an opening line", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const question = "How do you invoice the cafés now?";
    const adapter = scripted([
      { type: "note", text: question },
      { type: "activity", id: "p", label: "Updated the plan", status: "done", app: "tracker", action: "write", hidden: true },
      { type: "note-reply", text: question },
      { type: "text-delta", text: question },
    ]);
    const events = await collect(startTurn({ store, adapter, context: context(scopeA), idleTimeoutMs: 1000 }, { conversationId: id, kind: "send", text: "Invoices" }));
    const end = events.at(-1);
    if (end?.type !== "end") throw new Error("no end event");
    expect(end.message).toMatchObject({ status: "complete", content: question });
    expect(end.message.activity.filter((s) => s.action === "note")).toEqual([expect.objectContaining({ label: question, hidden: true })]);
  });

  it("keeps the run's trace id with the reply, out of what the browser gets", async () => {
    const db = createMemoryDb();
    const store = createMemoryStore(scopeA, db);
    const id = crypto.randomUUID();
    const adapter = scripted([{ type: "trace", traceId: "job-1" }, { type: "message", text: "Done" }]);
    const events = await collect(startTurn({ store, adapter, context: context(scopeA), idleTimeoutMs: 1000 }, { conversationId: id, kind: "send", text: "Hi" }));
    const reply = (await store.listMessages(id))[1];
    expect(await store.ratedReply(id, reply.id)).toEqual({ feedback: null, traceId: "job-1" });
    expect(JSON.stringify(events)).not.toContain("job-1");
    expect(await createMemoryStore(scopeB, db).ratedReply(id, reply.id)).toBeNull();
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

  it("stops when a stop is requested from elsewhere, checked on the heartbeat", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    let requested = false;
    let asked = 0;
    const stream = await startTurn(
      {
        store,
        adapter: createMockAdapter({ streaming: true, pace: 1 }),
        context: context(scopeA),
        idleTimeoutMs: 5000,
        heartbeatMs: 10,
        shouldStop: async () => (asked++, requested),
      },
      { conversationId: id, kind: "send", text: "help with operations" },
    );
    await stream.cancel(); // no one watching, as in the worker
    for (let i = 0; i < 100 && asked === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await store.listMessages(id))[1].status).toBe("streaming");
    requested = true;
    for (let i = 0; i < 100 && (await store.listMessages(id))[1]?.status === "streaming"; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await store.listMessages(id))[1].status).toBe("stopped");
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

  it("lets the member redirect a run: stops it, keeps its progress, and tells the agent", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const seen: AgentRunInput[] = [];
    let release!: () => void;
    const adapter: AgentAdapter = {
      ...scripted([]),
      async *run(input) {
        seen.push(input);
        if (seen.length > 1) {
          yield { type: "text-delta", text: "Switching to invoices." };
          return;
        }
        yield { type: "activity", id: "s1", label: "Searched your inbox", status: "done", app: "gmail" };
        yield { type: "text-delta", text: "Looking at receipts" };
        // Works until stopped.
        await new Promise<void>((resolve) => {
          release = resolve;
          input.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const deps = { store, adapter, context: context(scopeA), idleTimeoutMs: 5000, checkpointMs: 0 };
    const reader = (await startTurn(deps, { conversationId: id, kind: "send", text: "find receipts" })).getReader();
    const decoder = new TextDecoder();
    let streamed = "";
    while (!streamed.includes('"type":"text"')) streamed += decoder.decode((await reader.read()).value);
    const first = (async () => {
      while (!(await reader.read()).done) {
        // drain until the stopped run closes its stream
      }
    })();

    await expect(startTurn(deps, { conversationId: id, kind: "send", text: "actually invoices" })).rejects.toMatchObject({ status: 409 });
    const second = await collect(startTurn(deps, { conversationId: id, kind: "send", text: "actually invoices", steer: true }));
    await first;
    expect(release).toBeTypeOf("function");

    const messages = await store.listMessages(id);
    expect(messages.map((m) => [m.role, m.status, m.content])).toEqual([
      ["user", "complete", "find receipts"],
      ["assistant", "stopped", "Looking at receipts"],
      ["user", "complete", "actually invoices"],
      ["assistant", "complete", "Switching to invoices."],
    ]);
    expect(second.at(-1)).toMatchObject({ type: "end", message: { status: "complete" } });
    expect(seen[1].message).toContain("Searched your inbox");
    expect(seen[1].message).toContain("Looking at receipts");
    expect(seen[1].message.endsWith("actually invoices")).toBe(true);
  });

  it("sends a steer as a plain message once the run has already finished", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const seen: AgentRunInput[] = [];
    const deps = { store, adapter: scripted([{ type: "message", text: "ok" }], undefined, seen), context: context(scopeA), idleTimeoutMs: 1000 };
    await collect(startTurn(deps, { conversationId: id, kind: "send", text: "one" }));
    await collect(startTurn(deps, { conversationId: id, kind: "send", text: "two", steer: true }));
    expect(seen[1].message).toBe("two");
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

  it("declines the pending request when the member writes instead, and tells the agent", async () => {
    const seen: AgentRunInput[] = [];
    const discarded: unknown[] = [];
    const adapter = { ...pausing(seen), discard: async (state: unknown) => void discarded.push(state) };
    const { id, deps, approval, store } = await pause(createMemoryStore(scopeA), seen, adapter);
    await collect(startTurn(deps, { conversationId: id, kind: "send", text: "Send it to Sam instead", steer: true }));
    expect(discarded).toEqual([{ jobId: "job-1", requestId: "r-1" }]);
    expect(await store.getApproval(approval.id)).toMatchObject({ status: "declined" });
    const messages = await store.listMessages(id);
    expect(messages.map((m) => m.status)).toEqual(["complete", "stopped", "complete", "awaiting"]); // the new reply asks again
    expect(seen[1].resume).toBeUndefined();
    expect(seen[1].message).toContain('"Send the reply to Jo"');
    expect(seen[1].message).toContain("Found the thread");
    await expect(startTurn(deps, { conversationId: id, kind: "decide", approvalId: approval.id, decision: "approve" })).rejects.toMatchObject({ status: 409 });
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

  it("starts a conversation in a project and gives the agent the project's files ahead of the message's", async () => {
    const db = createMemoryDb();
    const store = createMemoryStore(scopeA, db);
    db.attachments.push({ id: "m1", name: "note.txt", mimeType: "text/plain", size: 3, storagePath: "ws-a/user-a/m1", messageId: null, ...scopeA });
    const seen: AgentRunInput[] = [];
    const projectFile = { id: "p1", name: "brief.pdf", mimeType: "application/pdf", size: 9, read: async () => new Blob(["brief"]) };
    const adapter = { ...scripted([{ type: "message", text: "ok" }], undefined, seen) };
    const deps = {
      store,
      adapter,
      context: context(scopeA),
      idleTimeoutMs: 1000,
      projectFiles: [projectFile],
      loadAttachment: async (a: { storagePath: string }) => new Blob([a.storagePath]),
    };
    const id = crypto.randomUUID();
    const events = await collect(startTurn(deps, { conversationId: id, kind: "send", text: "go", projectId: "proj-1", attachmentIds: ["m1"] }));
    expect(events[0]).toMatchObject({ type: "start", conversation: { projectId: "proj-1" } });
    expect(await store.getConversation(id)).toMatchObject({ projectId: "proj-1" });
    expect(seen[0].attachments.map((a) => a.name)).toEqual(["brief.pdf", "note.txt"]);

    // A later message keeps the conversation where it is; the project files come along again.
    await collect(startTurn(deps, { conversationId: id, kind: "send", text: "more", projectId: "proj-2" }));
    expect(await store.getConversation(id)).toMatchObject({ projectId: "proj-1" });
    expect(seen[1].attachments.map((a) => a.name)).toEqual(["brief.pdf"]);
  });

  it("refuses files when the agent can't read them", async () => {
    const store = createMemoryStore(scopeA);
    const adapter = { ...scripted([]), capabilities: { ...caps, attachments: false } };
    await expect(
      startTurn({ store, adapter, context: context(scopeA), idleTimeoutMs: 1000 }, { conversationId: crypto.randomUUID(), kind: "send", text: "x", attachmentIds: ["f1"] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("saves what the agent remembers right away, keeping its id so the member can undo it", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const saved: [string, string, unknown][] = [];
    const adapter = scripted([
      { type: "memory-proposal", content: "Ships orders on Tuesdays.", scope: "workspace", category: "policies" },
      { type: "memory-proposal", content: "Prefers short replies.", scope: "personal" },
      { type: "message", text: "Got it." },
    ]);
    const remember = async (content: string, scope: string, options: unknown) => {
      if (scope === "personal") throw new Error("memory down");
      saved.push([content, scope, options]);
      return "workspace:doc1";
    };
    const events = await collect(startTurn({ store, adapter, context: context(scopeA), idleTimeoutMs: 1000, remember }, { conversationId: id, kind: "send", text: "x" }));
    const reply = (await store.listMessages(id))[1];
    // Saved with its category and the reply it came from, so Business Brain can link back.
    expect(saved).toEqual([["Ships orders on Tuesdays.", "workspace", { category: "policies", source: { conversationId: id, messageId: reply.id } }]]);
    expect(reply.memoryProposals).toEqual([
      { id: expect.any(String), content: "Ships orders on Tuesdays.", scope: "workspace", status: "saved", memoryId: "workspace:doc1", category: "policies" },
      // Saving failed: it stays a suggestion the member can save.
      { id: expect.any(String), content: "Prefers short replies.", scope: "personal", status: "pending" },
    ]);
    expect(events.filter((e) => e.type === "memory-proposal").map((e) => e.type === "memory-proposal" && e.proposal.status)).toEqual(["saved", "pending"]);
    const end = events.find((e) => e.type === "end");
    expect(end?.type === "end" && end.message.memoryProposals?.map((p) => p.status)).toEqual(["saved", "pending"]);
  });

  it("hands the agent's plan and tracker rows to the task savers, capped per run, and labels a task's message", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const plans: unknown[] = [];
    const records: [unknown, { messageId: string }][] = [];
    const adapter = scripted([
      { type: "plan-update", plan: [{ text: "Find roles", status: "doing" }] },
      ...Array.from({ length: 30 }, (_, i) => ({ type: "record" as const, record: { collection: "applications", key: `k${i}` } })),
      { type: "message", text: "Found some." },
    ]);
    await collect(
      startTurn(
        {
          store,
          adapter,
          context: context(scopeA),
          idleTimeoutMs: 1000,
          savePlan: async (plan) => (plans.push(plan), true),
          saveRecord: async (record, source) => (records.push([record, source]), true),
        },
        { conversationId: id, kind: "send", text: "Find roles", origin: { kind: "task", taskId: "t1", title: "Job hunt", runId: null } },
      ),
    );
    const [asked, reply] = await store.listMessages(id);
    expect(plans).toEqual([[{ text: "Find roles", status: "doing" }]]);
    expect(records).toHaveLength(25);
    expect(records[0][1]).toEqual({ messageId: reply.id });
    expect(asked.origin).toEqual({ kind: "task", taskId: "t1", title: "Job hunt", runId: null });
  });

  it("passes the agent's run report to onFinished, ignoring malformed ones", async () => {
    const reports: unknown[] = [];
    for (const report of [{ outcome: "nothing_new", summary: "  No   replies " }, { outcome: "bogus" }]) {
      const store = createMemoryStore(scopeA);
      const adapter = scripted([{ type: "run-report", report }, { type: "message", text: "Checked." }]);
      await collect(
        startTurn(
          { store, adapter, context: context(scopeA), idleTimeoutMs: 1000, onFinished: (_m, _c, info) => void reports.push(info.report) },
          { conversationId: crypto.randomUUID(), kind: "send", text: "x" },
        ),
      );
    }
    expect(reports).toEqual([{ outcome: "nothing_new", summary: "No replies" }, null]);
  });

  it("drops plan and tracker reports when nothing can save them", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const adapter = scripted([
      { type: "plan-update", plan: [{ text: "x", status: "todo" }] },
      { type: "record", record: { collection: "a", key: "b" } },
      { type: "message", text: "Done." },
    ]);
    await collect(startTurn({ store, adapter, context: context(scopeA), idleTimeoutMs: 1000 }, { conversationId: id, kind: "send", text: "x" }));
    expect((await store.listMessages(id))[1].status).toBe("complete");
  });

  it("keeps a why-timeline only for members who have it, linking only links this run saw", async () => {
    const script = () =>
      scripted([
        {
          type: "activity",
          id: "a1",
          label: "Read orders",
          status: "done",
          preview: { type: "items", items: [{ primary: "Order #1", url: "https://shop.example/orders/1" }] },
        },
        {
          type: "timeline",
          timeline: {
            question: "Why?",
            entries: [
              { when: "2026-10-02", what: "Refund", url: "https://shop.example/orders/1" },
              { when: "2026-10-01", what: "Invented", url: "https://shop.example/orders/2" },
            ],
            causes: [{ text: "Refunds", entries: [0] }],
          },
        },
        { type: "message", text: "Done." },
      ]);
    const store = createMemoryStore(scopeA);
    const on = crypto.randomUUID();
    const events = await collect(
      startTurn({ store, adapter: script(), context: context(scopeA), idleTimeoutMs: 1000, timelines: true }, { conversationId: on, kind: "send", text: "x" }),
    );
    const reply = (await store.listMessages(on))[1];
    expect(reply.timeline).toEqual({
      question: "Why?",
      entries: [
        { when: "2026-10-01", what: "Invented", verified: false },
        { when: "2026-10-02", what: "Refund", url: "https://shop.example/orders/1", verified: true },
      ],
      causes: [{ text: "Refunds", entries: [1] }],
    });
    expect(events.some((e) => e.type === "timeline")).toBe(true);

    const off = crypto.randomUUID();
    const quiet = await collect(startTurn({ store, adapter: script(), context: context(scopeA), idleTimeoutMs: 1000 }, { conversationId: off, kind: "send", text: "x" }));
    expect((await store.listMessages(off))[1].timeline ?? null).toBeNull();
    expect(quiet.some((e) => e.type === "timeline")).toBe(false);
  });

  it("keeps charts and tables for every member, with or without why-timelines", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const adapter = scripted([
      { type: "visual", visual: { kind: "table", title: "Roles side by side", columns: ["Role", "Pay"], rows: [["Senior PM, Acme", "$200k"]] } },
      { type: "message", text: "Done." },
    ]);
    const events = await collect(startTurn({ store, adapter, context: context(scopeA), idleTimeoutMs: 1000 }, { conversationId: id, kind: "send", text: "x" }));
    expect((await store.listMessages(id))[1].timeline?.visuals).toEqual([
      { kind: "table", title: "Roles side by side", columns: ["Role", "Pay"], rows: [["Senior PM, Acme", "$200k"]] },
    ]);
    expect(events.some((e) => e.type === "timeline")).toBe(true);
  });

  it("keeps citations from every cite call in a run, not just the last", async () => {
    const page = "https://news.example/raise";
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const adapter = scripted([
      { type: "evidence", items: [{ url: page, app: "web", title: "Raise", text: "Grew from 4 to 45 partners. Building the Reasoning Engine." }] },
      { type: "citations", citations: { sources: [{ n: 1, url: page, quote: "Grew from 4 to 45 partners" }] } },
      { type: "citations", citations: { sources: [{ n: 2, url: page, quote: "Building the Reasoning Engine" }, { n: 1, url: page, quote: "a later duplicate" }] } },
      { type: "message", text: "It grew fast [1] and is building an engine [2]." },
    ]);
    await collect(startTurn({ store, adapter, context: context(scopeA), idleTimeoutMs: 1000 }, { conversationId: id, kind: "send", text: "x" }));
    const reply = (await store.listMessages(id))[1];
    expect(reply.citations?.map((c) => [c.n, c.quote, c.quoteVerified])).toEqual([
      [1, "Grew from 4 to 45 partners", true],
      [2, "Building the Reasoning Engine", true],
    ]);
  });

  it("keeps the agent's questions on the reply, validated, even with no text", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const adapter = scripted([
      {
        type: "questions",
        questions: [
          { question: " Which   tone? ", header: "Tone", options: [{ label: "Warm" }, { label: "warm" }, { label: "Formal", description: "Like a letter" }] },
          { question: "Only one option", options: [{ label: "A" }] },
        ],
      },
    ]);
    const events = await collect(startTurn({ store, adapter, context: context(scopeA), idleTimeoutMs: 1000 }, { conversationId: id, kind: "send", text: "x" }));
    const reply = (await store.listMessages(id))[1];
    const expected = [{ question: "Which tone?", header: "Tone", options: [{ label: "Warm" }, { label: "Formal", description: "Like a letter" }], multiSelect: false }];
    expect(reply.status).toBe("complete");
    expect(reply.questions).toEqual(expected);
    expect(events.find((e) => e.type === "questions")).toEqual({ type: "questions", questions: expected });
  });

  it("keeps the agent's forms and proposals on the reply, validated, even with no text", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const adapter = scripted([
      { type: "ui", block: { form: { title: "Your search", fields: [{ kind: "text", label: "Roles" }, { kind: "nonsense", label: "x" }] } } },
      { type: "ui", block: { form: { title: "Empty", fields: [] } } },
      { type: "ui", block: { proposal: { summary: "s", instructions: "Be brief.", skills: ["find-roles", "not-a-skill"] } } },
    ]);
    const events = await collect(startTurn({ store, adapter, context: context(scopeA), idleTimeoutMs: 1000 }, { conversationId: id, kind: "send", text: "x" }));
    const reply = (await store.listMessages(id))[1];
    expect(reply.status).toBe("complete");
    expect(reply.ui).toMatchObject([
      { kind: "form", title: "Your search", fields: [{ kind: "text", id: "roles", label: "Roles" }], submitLabel: "Send" },
      { kind: "proposal", instructions: "Be brief.", skills: [{ catalogId: "find-roles" }] },
    ]);
    expect(events.filter((e) => e.type === "ui").at(-1)).toEqual({ type: "ui", ui: reply.ui });
  });

  it("shows a proposed merge of facts only as checked against the member's memory", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const raw = { memory_merge: { summary: "s", merges: [{ text: "A and B.", replaces: ["workspace:a", "workspace:b"] }] } };
    const adapter = scripted([{ type: "ui", block: raw }, { type: "ui", block: { memory_merge: { merges: [] } } }, { type: "message", text: "Here." }]);
    const card = {
      kind: "memory-merge" as const,
      id: "card",
      summary: "s",
      merges: [{ text: "A and B.", category: "team" as const, scope: "workspace" as const, pinned: false, originals: [] }],
    };
    const resolveMerge = vi.fn(async (block: unknown) => ((block as typeof raw).memory_merge.merges.length ? card : null));
    await collect(startTurn({ store, adapter, context: context(scopeA), idleTimeoutMs: 1000, resolveMerge }, { conversationId: id, kind: "send", text: "x" }));
    expect(resolveMerge).toHaveBeenCalledWith(raw);
    expect((await store.listMessages(id))[1].ui).toEqual([card]);

    // Without a way to check it (no memory), it isn't shown at all.
    const other = crypto.randomUUID();
    await collect(startTurn({ store, adapter: scripted([{ type: "ui", block: raw }]), context: context(scopeA), idleTimeoutMs: 1000 }, { conversationId: other, kind: "send", text: "x" }));
    expect((await store.listMessages(other))[1].ui ?? null).toBeNull();
  });

  it("keeps the agent's memory suggestions on the reply, pending, when there's no memory to save to", async () => {
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

describe("when a run ends", () => {
  it("reports the saved reply, watched while the browser is still reading", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const finished: { status: string; content: string; title: string; watched: boolean }[] = [];
    await collect(
      startTurn(
        {
          store,
          adapter: scripted([{ type: "message", text: "All set" }]),
          context: context(scopeA),
          idleTimeoutMs: 1000,
          onFinished: (message, conversation, { watched }) =>
            void finished.push({ status: message.status, content: message.content, title: conversation.title, watched }),
        },
        { conversationId: id, kind: "send", text: "Book it" },
      ),
    );
    expect(finished).toEqual([{ status: "complete", content: "All set", title: "Book it", watched: true }]);
  });

  it("reports unwatched once the browser has gone, and the run still finishes", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: AgentAdapter = {
      ...scripted([]),
      async *run() {
        await gate;
        yield { type: "message", text: "Done while you were away" };
      },
    };
    let report!: (r: { watched: boolean; status: string }) => void;
    const reported = new Promise<{ watched: boolean; status: string }>((r) => (report = r));
    const stream = await startTurn(
      { store, adapter: slow, context: context(scopeA), idleTimeoutMs: 1000, onFinished: (m, _c, { watched }) => report({ watched, status: m.status }) },
      { conversationId: id, kind: "send", text: "Go" },
    );
    const reader = stream.getReader();
    await reader.read(); // the start event
    await reader.cancel(); // the phone locks
    release();
    expect(await reported).toEqual({ watched: false, status: "complete" });
    expect((await store.listMessages(id))[1]).toMatchObject({ status: "complete", content: "Done while you were away" });
  });

  it("isn't stopped by a failing hook", async () => {
    const store = createMemoryStore(scopeA);
    const events = await collect(
      startTurn(
        {
          store,
          adapter: scripted([{ type: "message", text: "ok" }]),
          context: context(scopeA),
          idleTimeoutMs: 1000,
          onFinished: () => Promise.reject(new Error("push service down")),
        },
        { conversationId: crypto.randomUUID(), kind: "send", text: "Go" },
      ),
    );
    expect(events.at(-1)?.type).toBe("end");
  });
});

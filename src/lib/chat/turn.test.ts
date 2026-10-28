import { describe, expect, it, vi } from "vitest";
import { createMockAdapter } from "@/lib/agent/mock";
import { AgentError, type AgentAdapter, type AgentEvent, type AgentRunInput, type AgentTenantContext } from "@/lib/agent/types";
import { readNdjson } from "@/lib/client/api";
import { createMemoryDb, createMemoryStore } from "@/test/memory-store";
import type { Artifact, ChatMessage, Journey, StreamEvent } from "@/lib/types";
import { MAX_KEEP_GOING, renderContinueMessage, sanitizeArtifact, startTurn, stopRun, titleFromMessage, TurnError } from "./turn";

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

  it("streams a message said aloud back then the way a member without voice sees it, as their page does", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const deps = { store, adapter: scripted([{ type: "message", text: "Done" }]), context: context(scopeA), idleTimeoutMs: 1000 };
    await collect(startTurn({ ...deps, voice: true }, { conversationId: id, kind: "send", text: "for March", origin: { kind: "voice", via: "note" } }));
    const userId = (await store.listMessages(id))[0].id;
    const edit = async (voice: boolean) => {
      const events = await collect(startTurn({ ...deps, voice }, { conversationId: id, kind: "edit", messageId: userId, text: "for April" }));
      return events.find((e) => e.type === "start") as Extract<StreamEvent, { type: "start" }>;
    };
    expect((await edit(true)).userMessage?.origin).toEqual({ kind: "voice", via: "note" });
    expect((await edit(false)).userMessage?.origin).toBeNull();
    // What's stored stays as it was said.
    expect((await store.listMessages(id))[0].origin).toEqual({ kind: "voice", via: "note" });
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

  it("stops at the deadline and says it ran out of time, failing the step still going", async () => {
    const store = createMemoryStore(scopeA);
    let stopped = false;
    const slow: AgentAdapter = {
      ...scripted([]),
      async *run({ signal }) {
        signal.addEventListener("abort", () => (stopped = true));
        yield { type: "activity", id: "s1", label: "Pulling 90 days of Gmail", status: "running" };
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      },
    };
    const events = await collect(
      startTurn(
        { store, adapter: slow, context: context(scopeA), idleTimeoutMs: 5000, deadline: Date.now() + 30 },
        { conversationId: crypto.randomUUID(), kind: "send", text: "go" },
      ),
    );
    const end = events.at(-1);
    if (end?.type !== "end") throw new Error("no end");
    expect(end.message.status).toBe("error");
    expect(end.message.error).toMatch(/ran past the time one reply can take/);
    expect(end.message.activity[0]).toMatchObject({ status: "failed", detail: "Stopped when the reply ran out of time." });
    expect(stopped).toBe(true);
    const saved = (await store.listMessages(end.conversation.id)).at(-1);
    expect(saved?.status).toBe("error");
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

  it("stops when a stop is requested from elsewhere, checked every few seconds", async () => {
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
        stopCheckMs: 10,
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

  it("stops when Stop reaches another server: the reply's flag, which the run checks", async () => {
    const db = createMemoryDb();
    const store = createMemoryStore(scopeA, db);
    const id = crypto.randomUUID();
    const reader = (
      await startTurn(
        { store, adapter: createMockAdapter({ streaming: true, pace: 1 }), context: context(scopeA), idleTimeoutMs: 5000, stopCheckMs: 10, checkpointMs: 0 },
        { conversationId: id, kind: "send", text: "help with operations" },
      )
    ).getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes('"type":"text"')) seen += decoder.decode((await reader.read()).value);
    // Another member can't stop it; the member can, from a request this server never sees.
    expect(await createMemoryStore(scopeB, db).requestStop(id)).toBe(false);
    expect(await createMemoryStore(scopeA, db).requestStop(id)).toBe(true);
    let streamed = seen;
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) streamed += decoder.decode(chunk.value);
    expect(streamed).toContain('"status":"stopped"');
    const assistant = (await store.listMessages(id))[1];
    expect(assistant.status).toBe("stopped");
    expect(assistant.content.length).toBeGreaterThan(0);
    expect(await store.requestStop(id)).toBe(false); // nothing left streaming
  });

  it("forgets an earlier stop once the reply streams again", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    await store.createConversation({ id, title: "t" });
    const reply = await store.insertMessage({ id: crypto.randomUUID(), conversationId: id, role: "assistant", content: "", status: "streaming", activity: [], artifacts: [] });
    await store.requestStop(id);
    expect(await store.stopRequested(reply.id)).toBe(true);
    await store.updateMessage(reply.id, { status: "awaiting" });
    await store.updateMessage(reply.id, { status: "streaming" });
    expect(await store.stopRequested(reply.id)).toBe(false);
  });

  it("redirects a run on another server: asks it to stop, waits, then answers", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const seen: AgentRunInput[] = [];
    await store.createConversation({ id, title: "find receipts" });
    await store.insertMessage({ id: crypto.randomUUID(), conversationId: id, role: "user", content: "find receipts", status: "complete", activity: [], artifacts: [] });
    const remote = await store.insertMessage({
      id: crypto.randomUUID(),
      conversationId: id,
      role: "assistant",
      content: "Looking at receipts",
      status: "streaming",
      activity: [],
      artifacts: [],
    });
    // The other server's run, which stops on its next check.
    const other = (async () => {
      while (!(await store.stopRequested(remote.id))) await new Promise((r) => setTimeout(r, 5));
      await store.updateMessage(remote.id, { status: "stopped" });
    })();
    const deps = { store, adapter: scripted([{ type: "message", text: "Switching to invoices." }], undefined, seen), context: context(scopeA), idleTimeoutMs: 1000 };

    await expect(startTurn(deps, { conversationId: id, kind: "send", text: "actually invoices" })).rejects.toMatchObject({ status: 409 });
    const events = await collect(startTurn(deps, { conversationId: id, kind: "send", text: "actually invoices", steer: true }));
    await other;
    expect(events.at(-1)).toMatchObject({ type: "end", message: { status: "complete" } });
    expect((await store.listMessages(id)).map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "stopped"],
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
    expect(seen[0].message).toContain("Looking at receipts");
    expect(seen[0].message.endsWith("actually invoices")).toBe(true);
  });

  it("refuses to redirect a run on another server that doesn't stop in time", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    await store.createConversation({ id, title: "t" });
    await store.insertMessage({ id: crypto.randomUUID(), conversationId: id, role: "assistant", content: "", status: "streaming", activity: [], artifacts: [] });
    const deps = { store, adapter: scripted([]), context: context(scopeA), idleTimeoutMs: 1000, steerWaitMs: 40 };
    await expect(startTurn(deps, { conversationId: id, kind: "send", text: "stop", steer: true })).rejects.toMatchObject({ status: 409 });
    expect((await store.listMessages(id)).map((m) => m.role)).toEqual(["assistant"]); // nothing sent
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

  it("sends a page from before offers to call none of the offer already on a reply it continues, and keeps it saved", async () => {
    const { id, deps, approval, store } = await pause();
    const [, reply] = await store.listMessages(id);
    const offer = { kind: "offer" as const, id: "o1", reason: "Quicker to talk." };
    await store.updateMessage(reply.id, { ui: [offer] });
    const events = await collect(startTurn({ ...deps, offersShown: false }, { conversationId: id, kind: "decide", approvalId: approval.id, decision: "approve" }));
    expect(JSON.stringify(events)).not.toContain('"offer"');
    const start = events[0];
    expect(start.type === "start" && start.assistantMessage.ui).toEqual([]);
    const end = events.at(-1);
    expect(end?.type === "end" && end.message.ui).toEqual([]);
    expect((await store.listMessages(id))[1].ui).toEqual([offer]);
  });

  it("keeps what the agent said before the pause apart from what it says once the member decides", async () => {
    const before: AgentEvent[] = [{ type: "text-delta", text: "Here's the reply to Jo. Okay to send?" }, ...paused];
    const seen: AgentRunInput[] = [];
    const adapter = pausing(seen);
    // Says something before it pauses, then carries on with the default "Sent it." once resumed.
    const asking: AgentAdapter = {
      ...adapter,
      async *run(input) {
        if (input.resume) return yield* adapter.run(input);
        seen.push(input);
        yield* before;
      },
    };
    const { id, deps, approval, store } = await pause(createMemoryStore(scopeA), seen, asking);
    const events = await collect(startTurn(deps, { conversationId: id, kind: "decide", approvalId: approval.id, decision: "approve" }));
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("\n\nSent it.");
    const [, reply] = await store.listMessages(id);
    expect(reply.content).toBe("Here's the reply to Jo. Okay to send?\n\nSent it.");
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

  describe("decided by voice", () => {
    const actions = [{ tool: "GMAIL_REPLY_TO_THREAD", arguments: { thread_id: "t1", recipient_email: "jo@acme.example", message_body: "Hi Jo, sent it over." } }];
    const pausingWith = (event: Partial<Extract<AgentEvent, { type: "approval" }>>, seen: AgentRunInput[] = []): AgentAdapter => ({
      ...scripted([]),
      discard: async () => {},
      async *run(input) {
        seen.push(input);
        if (!input.resume) {
          yield { type: "approval", summary: "Send the reply to Jo", app: "gmail", details: [["To", "jo@acme.example"]], state: { jobId: "job-1" }, ...event };
          return;
        }
        yield { type: "text-delta", text: "Sent it." };
      },
    });
    const spoken = { heard: "send it", voiceSessionId: "call-1" };

    it("classifies the request when the agent asks, from what it would run, and tells the browser", async () => {
      const voiceOk = await pause(createMemoryStore(scopeA), [], pausingWith({ actions }));
      expect(voiceOk.approval.spoken).toEqual({ ok: true, readBack: "I'll reply in the thread to jo@acme.example, saying “Hi Jo, sent it over”." });
      expect(await voiceOk.store.getApproval(voiceOk.approval.id)).toMatchObject({ tools: ["GMAIL_REPLY_TO_THREAD"] });
      const money = await pause(createMemoryStore(scopeA), [], pausingWith({ actions: [{ tool: "STRIPE_CREATE_REFUND", arguments: {} }] }));
      expect(money.approval.spoken).toEqual({ ok: false, reason: "money" });
      // An adapter that can't say what it would run: a tap.
      expect((await pause()).approval.spoken).toEqual({ ok: false, reason: "unsupported" });
      // The raw arguments never reach the browser.
      expect(JSON.stringify(voiceOk.events)).not.toContain("t1");
    });

    it("stands only when the check says so, before the run is counted, and keeps the member's words", async () => {
      const seen: AgentRunInput[] = [];
      const { id, deps, approval, store } = await pause(createMemoryStore(scopeA), seen, pausingWith({ actions }, seen));
      const claim = vi.fn(async () => null);
      const allowSpokenDecision = vi.fn(async () => null);
      const events = await collect(startTurn({ ...deps, voice: true, claim, allowSpokenDecision }, { conversationId: id, kind: "decide", approvalId: approval.id, decision: "approve", spoken }));
      expect(allowSpokenDecision).toHaveBeenCalledWith(expect.objectContaining({ id: approval.id, spoken: expect.objectContaining({ ok: true }) }), "approve", spoken);
      expect(seen[1].resume).toMatchObject({ decision: "approve" });
      const end = events.at(-1);
      expect(end?.type === "end" && end.message.approvals?.[0]).toMatchObject({ status: "approved", decidedVia: "voice", decidedWords: "send it" });
      expect(await store.getApproval(approval.id)).toMatchObject({ status: "approved", decidedVia: "voice", decidedWords: "send it" });
    });

    it("is refused without the check, or when it fails, and the request keeps waiting", async () => {
      const { id, deps, approval, store } = await pause(createMemoryStore(scopeA), [], pausingWith({ actions }));
      const claim = vi.fn(async () => null);
      await expect(startTurn({ ...deps, claim }, { conversationId: id, kind: "decide", approvalId: approval.id, decision: "approve", spoken })).rejects.toMatchObject({ status: 403 });
      const refusing = vi.fn(async () => "Approvals are taps for now.");
      await expect(
        startTurn({ ...deps, claim, allowSpokenDecision: refusing }, { conversationId: id, kind: "decide", approvalId: approval.id, decision: "approve", spoken }),
      ).rejects.toMatchObject({ status: 403, message: "Approvals are taps for now." });
      expect(claim).not.toHaveBeenCalled();
      expect(await store.getApproval(approval.id)).toMatchObject({ status: "pending" });
      expect((await store.getApproval(approval.id))?.decidedVia).toBeUndefined();
      // A tap still answers it, and says so.
      await collect(startTurn(deps, { conversationId: id, kind: "decide", approvalId: approval.id, decision: "approve" }));
      expect(await store.getApproval(approval.id)).toMatchObject({ status: "approved", decidedVia: "tap" });
      expect((await store.getApproval(approval.id))?.decidedWords).toBeUndefined();
    });

    it("declines by voice with the member's words; writing instead declines with no one's", async () => {
      const { id, deps, approval, store } = await pause(createMemoryStore(scopeA), [], pausingWith({ actions: [{ tool: "STRIPE_CREATE_REFUND", arguments: {} }] }));
      const allowSpokenDecision = vi.fn(async () => null);
      await collect(startTurn({ ...deps, allowSpokenDecision }, { conversationId: id, kind: "decide", approvalId: approval.id, decision: "reject", spoken: { heard: "don't send it", voiceSessionId: "call-1" } }));
      expect(allowSpokenDecision).toHaveBeenCalledWith(expect.anything(), "reject", { heard: "don't send it", voiceSessionId: "call-1" });
      expect(await store.getApproval(approval.id)).toMatchObject({ status: "declined", decidedVia: "voice", decidedWords: "don't send it" });

      const steered = await pause(createMemoryStore(scopeA), [], pausingWith({ actions }));
      await collect(startTurn(steered.deps, { conversationId: steered.id, kind: "send", text: "Send it to Sam instead", steer: true }));
      const declined = await steered.store.getApproval(steered.approval.id);
      expect(declined).toMatchObject({ status: "declined" });
      expect(declined?.decidedVia).toBeUndefined();
    });

    it("can't approve a tap-only request by voice even if the check were wrong", async () => {
      const { id, deps, approval } = await pause(createMemoryStore(scopeA), [], pausingWith({ actions: [{ tool: "STRIPE_CREATE_REFUND", arguments: {} }] }));
      // The database's own check (settle_spoken_approval, mirrored by the test store) refuses it, and it keeps waiting.
      await expect(
        startTurn({ ...deps, allowSpokenDecision: async () => null }, { conversationId: id, kind: "decide", approvalId: approval.id, decision: "approve", spoken }),
      ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("couldn't be answered by voice") });
    });

    it("records a spoken decision with the call it was said on, and refuses one with none", async () => {
      const { id, deps, approval, store } = await pause(createMemoryStore(scopeA), [], pausingWith({ actions }));
      const settle = vi.spyOn(store, "settleApproval");
      const allowSpokenDecision = async () => null;
      await expect(
        startTurn({ ...deps, allowSpokenDecision }, { conversationId: id, kind: "decide", approvalId: approval.id, decision: "approve", spoken: { heard: "send it", voiceSessionId: "" } }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await store.getApproval(approval.id)).toMatchObject({ status: "pending" });
      await collect(startTurn({ ...deps, allowSpokenDecision }, { conversationId: id, kind: "decide", approvalId: approval.id, decision: "approve", spoken }));
      expect(settle).toHaveBeenLastCalledWith(approval.id, "pending", "approved", { via: "voice", words: "send it", call: "call-1" });
    });
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

  describe("a standing OK", () => {
    const labels = {
      type: "approval",
      summary: "Label 3 threads Priority",
      app: "gmail",
      details: [],
      actions: [{ tool: "GMAIL_BATCH_MODIFY_MESSAGES", arguments: { messageIds: ["m1", "m2", "m3"], addLabelIds: ["Label_1"] } }],
      state: { jobId: "job-2" },
    } as AgentEvent;
    const sending = { ...labels, summary: "Send it", actions: [{ tool: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "jo@acme.example" } }] } as AgentEvent;

    async function pauseOn(event: AgentEvent, standing?: { allowed: string[] }) {
      const store = createMemoryStore(scopeA);
      const granted: string[] = [];
      const adapter: AgentAdapter = {
        ...scripted([]),
        discard: async () => {},
        async *run(input) {
          if (input.resume) yield { type: "text-delta", text: "Done." };
          else yield event;
        },
      };
      const deps = {
        store,
        adapter,
        context: context(scopeA),
        idleTimeoutMs: 1000,
        ...(standing ? { standing: { allowed: standing.allowed as "gmail_labels"[], grant: async (k: string) => Boolean(granted.push(k)) } } : {}),
      };
      const id = crypto.randomUUID();
      const events = await collect(startTurn(deps, { conversationId: id, kind: "send", text: "Sort my mail" }));
      const found = events.find((e) => e.type === "approval");
      if (found?.type !== "approval") throw new Error("no approval");
      return { id, deps, store, granted, approval: found.approval };
    }

    it("marks only requests of a kind that qualifies, and only where standing OKs are on", async () => {
      expect((await pauseOn(labels, { allowed: [] })).approval.standing).toBe("gmail_labels");
      expect((await pauseOn(sending, { allowed: [] })).approval.standing).toBeUndefined();
      expect((await pauseOn(labels)).approval.standing).toBeUndefined();
    });

    it("marks a request the member already OK'd as going ahead on its own, and nothing else", async () => {
      expect((await pauseOn(labels, { allowed: ["gmail_labels"] })).approval.auto).toBe(true);
      expect((await pauseOn(labels, { allowed: [] })).approval.auto).toBeUndefined();
      expect((await pauseOn(sending, { allowed: ["gmail_labels"] })).approval.auto).toBeUndefined();
    });

    it("saves the OK when the member taps Approve with it, and approves this one as a tap", async () => {
      const { id, deps, store, granted, approval } = await pauseOn(labels, { allowed: [] });
      await collect(startTurn(deps, { conversationId: id, kind: "decide", approvalId: approval.id, decision: "approve", standing: "grant" }));
      expect(granted).toEqual(["gmail_labels"]);
      expect(await store.getApproval(approval.id)).toMatchObject({ status: "approved", decidedVia: "tap" });
    });

    it("lets the run approve a request the member already OK'd, and records it as theirs", async () => {
      const { id, deps, store, approval } = await pauseOn(labels, { allowed: ["gmail_labels"] });
      const events = await collect(startTurn(deps, { conversationId: id, kind: "decide", approvalId: approval.id, decision: "approve", standing: "auto" }));
      const end = events.at(-1);
      expect(end?.type === "end" && end.message.approvals?.[0]).toMatchObject({ status: "approved", decidedVia: "standing" });
      expect(await store.getApproval(approval.id)).toMatchObject({ status: "approved", decidedVia: "standing" });
    });

    it("never approves without the OK, for another kind, or where standing OKs are off", async () => {
      const notYet = await pauseOn(labels, { allowed: [] });
      await expect(
        startTurn(notYet.deps, { conversationId: notYet.id, kind: "decide", approvalId: notYet.approval.id, decision: "approve", standing: "auto" }),
      ).rejects.toMatchObject({ status: 403 });
      const send = await pauseOn(sending, { allowed: ["gmail_labels"] });
      for (const standing of ["auto", "grant"] as const) {
        await expect(
          startTurn(send.deps, { conversationId: send.id, kind: "decide", approvalId: send.approval.id, decision: "approve", standing }),
        ).rejects.toMatchObject({ status: 409 });
      }
      const elsewhere = await pauseOn(labels);
      await expect(
        startTurn(elsewhere.deps, { conversationId: elsewhere.id, kind: "decide", approvalId: elsewhere.approval.id, decision: "approve", standing: "grant" }),
      ).rejects.toMatchObject({ status: 409 });
      for (const t of [notYet, send, elsewhere]) expect(await t.store.getApproval(t.approval.id)).toMatchObject({ status: "pending" });
    });
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
      return { id: "workspace:doc1" };
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

  it("passes on the facts a remembered one replaces, and keeps what it replaced for Undo", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const asked: unknown[] = [];
    const adapter = scripted([
      { type: "memory-proposal", content: "Auto-print is cut for now.", scope: "workspace", replaces: ["workspace:a1"] },
      { type: "message", text: "Got it." },
    ]);
    const replaced = [{ id: "workspace:a1", content: "Labels print automatically.", scope: "workspace" as const, category: "other" as const, pinned: false, createdBy: "u", savedAt: 1 }];
    const remember = async (_content: string, _scope: string, options: unknown) => (asked.push(options), { id: "workspace:new", replaced });
    await collect(startTurn({ store, adapter, context: context(scopeA), idleTimeoutMs: 1000, remember }, { conversationId: id, kind: "send", text: "x" }));
    expect(asked).toEqual([expect.objectContaining({ replaces: ["workspace:a1"] })]);
    expect((await store.listMessages(id))[1].memoryProposals).toEqual([expect.objectContaining({ status: "saved", memoryId: "workspace:new", replaced })]);
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
    const events = await collect(
      startTurn(
        {
          store,
          adapter,
          context: context(scopeA),
          idleTimeoutMs: 1000,
          savePlan: async (plan) => (plans.push(plan), null),
          // One row that doesn't validate: nothing is said about it.
          saveRecord: async (record, source) => (records.push([record, source]), records.length === 1 ? null : "leads"),
        },
        { conversationId: id, kind: "send", text: "Find roles", origin: { kind: "task", taskId: "t1", title: "Job hunt", runId: null } },
      ),
    );
    const [asked, reply] = await store.listMessages(id);
    expect(plans).toEqual([[{ text: "Find roles", status: "doing" }]]);
    expect(records).toHaveLength(25);
    expect(records[0][1]).toEqual({ messageId: reply.id });
    // Each saved row is said once it's saved, so the page can show where it landed.
    expect(events.filter((e) => e.type === "saved")).toHaveLength(24);
    expect(events.find((e) => e.type === "saved")).toEqual({ type: "saved", target: { kind: "record", collection: "leads" } });
    expect(asked.origin).toEqual({ kind: "task", taskId: "t1", title: "Job hunt", runId: null });
  });

  it("keeps the conversation's browser server-side: recorded, never streamed or stored with the reply", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const recorded: (string | null)[] = [];
    const session = "33333333-3333-4333-8333-333333333333";
    const adapter = scripted([{ type: "browser-session", sessionId: session }, { type: "message", text: "Looked." }, { type: "browser-session", sessionId: null }]);
    const events = await collect(
      startTurn(
        { store, adapter, context: context(scopeA), idleTimeoutMs: 1000, saveBrowserSession: async (s) => void recorded.push(s) },
        { conversationId: id, kind: "send", text: "Look it up" },
      ),
    );
    expect(recorded).toEqual([session, null]);
    expect(JSON.stringify(events)).not.toContain(session);
    expect(JSON.stringify(await store.listMessages(id))).not.toContain(session);
  });

  it("saves the agent's plans one at a time, in order, and streams each saved journey as it lands", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const saving: string[] = [];
    let saved: { steps: unknown; goal: unknown } | null = null;
    const adapter = scripted([
      { type: "plan-update", plan: [{ text: "Find caterers", status: "doing" }], goal: "three caterers under $40 a head" },
      { type: "plan-update", plan: [{ text: "Find caterers", status: "done" }] },
      // Refused by the saver: no journey goes out for it.
      { type: "plan-update", plan: "not a plan" },
      { type: "message", text: "Found three." },
    ]);
    const savePlan = async (plan: unknown, goal: unknown): Promise<Journey | null> => {
      saving.push(`start ${JSON.stringify(plan)}`);
      // The first save is the slowest; a later one still waits for it.
      await new Promise((r) => setTimeout(r, saved ? 0 : 30));
      saving.push(`end ${JSON.stringify(plan)}`);
      if (!Array.isArray(plan)) return null;
      saved = { steps: plan, goal: goal ?? (saved?.goal as string | undefined) ?? null };
      return { kind: "conversation", goal: saved.goal as string | null, steps: plan as Journey["steps"], updatedAt: 1 };
    };
    const events = await collect(startTurn({ store, adapter, context: context(scopeA), idleTimeoutMs: 1000, savePlan }, { conversationId: id, kind: "send", text: "Find caterers" }));
    expect(saving.map((s) => s.split(" ")[0])).toEqual(["start", "end", "start", "end", "start", "end"]);
    const journeys = events.filter((e) => e.type === "journey").map((e) => e.type === "journey" && e.journey);
    expect(journeys).toEqual([
      { kind: "conversation", goal: "three caterers under $40 a head", steps: [{ text: "Find caterers", status: "doing" }], updatedAt: 1 },
      { kind: "conversation", goal: "three caterers under $40 a head", steps: [{ text: "Find caterers", status: "done" }], updatedAt: 1 },
    ]);
    // Every journey goes out before the reply ends.
    expect(events.findIndex((e) => e.type === "journey")).toBeLessThan(events.findIndex((e) => e.type === "end"));
  });

  it("files the reply's linked artifacts in the Library, once each and capped per run", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const filed: [string, { messageId: string }][] = [];
    const adapter = scripted([
      { type: "artifact", artifact: { id: "doc", kind: "document", title: "Cover letter", url: "https://docs.google.com/document/d/1" } },
      { type: "artifact", artifact: { id: "doc", kind: "document", title: "Cover letter", url: "https://docs.google.com/document/d/1" } },
      // No link: nothing to open later, so it stays on the reply only.
      { type: "artifact", artifact: { id: "local", kind: "file", title: "Notes" } },
      ...Array.from({ length: 12 }, (_, i) => ({
        type: "artifact" as const,
        artifact: { id: `s${i}`, kind: "spreadsheet" as const, title: `Sheet ${i}`, url: `https://docs.google.com/spreadsheets/d/${i}` },
      })),
      { type: "message", text: "Done." },
    ]);
    await collect(
      startTurn(
        { store, adapter, context: context(scopeA), idleTimeoutMs: 1000, fileArtifact: async (a, source) => void filed.push([a.title, source]) },
        { conversationId: id, kind: "send", text: "Write it" },
      ),
    );
    const [, reply] = await store.listMessages(id);
    expect(reply.artifacts).toHaveLength(14);
    expect(filed).toHaveLength(10);
    expect(filed[0]).toEqual(["Cover letter", { messageId: reply.id }]);
    expect(filed.map(([title]) => title)).not.toContain("Notes");
  });

  it("files links the agent saved to the Library on request: https with a title only, kind guessed when missing, not shown on the reply", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const filed: [Artifact, { messageId: string }][] = [];
    const adapter = scripted([
      { type: "library-item", item: { url: "https://docs.google.com/spreadsheets/d/9/edit", title: "  Budget  " } },
      { type: "library-item", item: { url: "https://example.com/brief.pdf", title: "Brief", kind: "document" } },
      { type: "library-item", item: { url: "https://example.com/x", title: "Odd kind", kind: "hologram" } },
      // Refused: not https, no title, not a link at all.
      { type: "library-item", item: { url: "http://example.com/y", title: "Plain http" } },
      { type: "library-item", item: { url: "javascript:alert(1)", title: "Script" } },
      { type: "library-item", item: { url: "https://example.com/z", title: "   " } },
      { type: "library-item", item: "https://example.com/w" },
      { type: "message", text: "Saved." },
    ]);
    await collect(
      startTurn(
        { store, adapter, context: context(scopeA), idleTimeoutMs: 1000, fileArtifact: async (a, source) => void filed.push([a, source]) },
        { conversationId: id, kind: "send", text: "Save my budget sheet to my library" },
      ),
    );
    const [, reply] = await store.listMessages(id);
    expect(filed.map(([a]) => a)).toEqual([
      { id: "https://docs.google.com/spreadsheets/d/9/edit", kind: "spreadsheet", title: "Budget", url: "https://docs.google.com/spreadsheets/d/9/edit", source: "Google Sheets" },
      { id: "https://example.com/brief.pdf", kind: "document", title: "Brief", url: "https://example.com/brief.pdf", source: "example.com" },
      { id: "https://example.com/x", kind: "link", title: "Odd kind", url: "https://example.com/x", source: "example.com" },
    ]);
    expect(filed[0][1]).toEqual({ messageId: reply.id });
    expect(reply.artifacts).toEqual([]);
    expect(reply.content).toBe("Saved.");
  });

  it("saves files the agent got from its browser on the reply, one at a time, and says which it couldn't get", async () => {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const asked: [unknown, { messageId: string }][] = [];
    const adapter = scripted([
      { type: "browser-file", file: { name: "Label.pdf", link: "/label/1.pdf" } },
      { type: "browser-file", file: { name: "Receipt.pdf" } },
      { type: "browser-file", file: "not a request" },
      { type: "message", text: "Here's your label." },
    ]);
    const label = { id: crypto.randomUUID(), name: "Label.pdf", mimeType: "application/pdf", size: 2048 };
    const events = await collect(
      startTurn(
        {
          store,
          adapter,
          context: context(scopeA),
          idleTimeoutMs: 1000,
          saveBrowserFile: async (file, source) => {
            asked.push([file, source]);
            const name = (file as { name?: string }).name;
            if (name === "Label.pdf") return { ok: true, attachment: label };
            if (name === "Receipt.pdf") return { ok: false, name, why: "the browser had closed" };
            return null;
          },
        },
        { conversationId: id, kind: "send", text: "Make the label" },
      ),
    );
    const [, reply] = await store.listMessages(id);
    expect(asked.map(([f]) => f)).toEqual([{ name: "Label.pdf", link: "/label/1.pdf" }, { name: "Receipt.pdf" }, "not a request"]);
    expect(asked[0][1]).toEqual({ messageId: reply.id });
    expect(events.filter((e) => e.type === "file")).toEqual([{ type: "file", attachment: label }]);
    const end = events.find((e) => e.type === "end") as Extract<StreamEvent, { type: "end" }>;
    expect(end.message.attachments).toEqual([label]);
    expect(end.message.content).toBe("Here's your label.\n\n_Couldn't get Receipt.pdf from the browser: the browser had closed._");
    expect(reply.content).toBe(end.message.content);
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

  it("shows the agent's offer to call only where the member could take one, after the cards it keeps", async () => {
    const offer = { offer_call: { reason: "Quicker to talk it through.", topic: "Which offer" } };
    const form = (title: string) => ({ form: { title, fields: [{ kind: "text", label: "Roles" }] } });
    const run = async (offerCalls: boolean | undefined) => {
      const store = createMemoryStore(scopeA);
      const id = crypto.randomUUID();
      const adapter = scripted([
        { type: "message", text: "Here are the trade-offs." },
        { type: "ui", block: form("One") },
        { type: "ui", block: offer },
        { type: "ui", block: form("Two") },
        { type: "ui", block: { proposal: { summary: "s", instructions: "Be brief." } } },
      ]);
      await collect(startTurn({ store, adapter, context: context(scopeA), idleTimeoutMs: 1000, offerCalls }, { conversationId: id, kind: "send", text: "x" }));
      return (await store.listMessages(id))[1].ui ?? [];
    };
    // The offer doesn't take a card's place: the latest two cards, then the offer, last.
    expect((await run(true)).map((b) => b.kind)).toEqual(["form", "proposal", "offer"]);
    expect((await run(true)).at(-1)).toMatchObject({ kind: "offer", reason: "Quicker to talk it through.", topic: "Which offer" });
    // No calls for this member, on a call, or after they said Not now here: no offer.
    expect((await run(false)).map((b) => b.kind)).toEqual(["form", "proposal"]);
    expect((await run(undefined)).map((b) => b.kind)).toEqual(["form", "proposal"]);
  });

  it("offers ways to sound only to a member with voice", async () => {
    const sound = [{ voice: "warm", manner: "Easy and brief." }];
    const run = async (voice: boolean | undefined) => {
      const store = createMemoryStore(scopeA);
      const id = crypto.randomUUID();
      const adapter = scripted([
        { type: "message", text: "A few ways I could be." },
        { type: "ui", block: { proposal: { summary: "s", instructions: "Be brief.", sound } } },
        { type: "ui", block: { proposal: { summary: "How I'll sound.", sound } } },
      ]);
      await collect(startTurn({ store, adapter, context: context(scopeA), idleTimeoutMs: 1000, voice }, { conversationId: id, kind: "send", text: "x" }));
      return (await store.listMessages(id))[1].ui ?? [];
    };
    expect(await run(true)).toMatchObject([
      { kind: "proposal", instructions: "Be brief.", sound },
      { kind: "proposal", summary: "How I'll sound.", sound },
    ]);
    // Without voice the options go, and so does a proposal of nothing but them.
    for (const off of [false, undefined]) {
      const ui = await run(off);
      expect(ui).toHaveLength(1);
      expect(ui[0]).toMatchObject({ kind: "proposal", instructions: "Be brief." });
      expect(ui[0]).not.toHaveProperty("sound");
    }
  });

  it("hands the member the browser only where they could take it over, and only to pages that know it", async () => {
    const handoff = { hand_browser: { reason: "Sign in to your USPS account.", site: "USPS" } };
    const run = async (deps: { handoffs?: boolean; handoffsShown?: boolean }) => {
      const store = createMemoryStore(scopeA);
      const id = crypto.randomUUID();
      const adapter = scripted([{ type: "message", text: "Your turn." }, { type: "ui", block: handoff }]);
      const events = await collect(startTurn({ store, adapter, context: context(scopeA), idleTimeoutMs: 1000, ...deps }, { conversationId: id, kind: "send", text: "x" }));
      return { saved: (await store.listMessages(id))[1].ui ?? [], streamed: JSON.stringify(events) };
    };
    const shown = await run({ handoffs: true, handoffsShown: true });
    expect(shown.saved).toMatchObject([{ kind: "browser", reason: "Sign in to your USPS account.", site: "USPS" }]);
    expect(shown.streamed).toContain('"browser"');
    // No hosted browser the app can reach: no card.
    expect((await run({})).saved).toEqual([]);
    expect((await run({ handoffs: false, handoffsShown: true })).saved).toEqual([]);
    // A page from before hand-offs isn't sent it, but it's kept for the next load.
    const old = await run({ handoffs: true, handoffsShown: false });
    expect(old.streamed).not.toContain('"browser"');
    expect(old.saved).toHaveLength(1);
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

describe("voice notes", () => {
  const VOICE_MESSAGE = { kind: "voice", via: "note" } as const;
  const TASK = { kind: "task", taskId: "t1", title: "Job hunt", runId: null } as const;

  async function turn(origin: ChatMessage["origin"], events: AgentEvent[], { voiceNotes = true, fail }: { voiceNotes?: boolean; fail?: AgentError } = {}) {
    const store = createMemoryStore(scopeA);
    const id = crypto.randomUUID();
    const finished: ChatMessage[] = [];
    const streamed = await collect(
      startTurn(
        { store, adapter: scripted(events, fail), context: context(scopeA), idleTimeoutMs: 1000, voice: true, voiceNotes, onFinished: (m) => void finished.push(m) },
        { conversationId: id, kind: "send", text: "Find me roles", origin: origin ?? undefined },
      ),
    );
    const end = streamed.at(-1);
    if (end?.type !== "end") throw new Error("no end event");
    return { store, id, end: end.message, finished: finished[0], saved: (await store.listMessages(id))[1] };
  }

  it("come back on a reply to a voice message, saved with the reply and carried by its end event", async () => {
    const { end, saved, finished } = await turn(VOICE_MESSAGE, [{ type: "message", text: "Found three. The best is remote.\n\n- Acme\n- Globex\n- Initech" }]);
    const note = { script: "Found three. The best is remote. The rest is on screen.", source: "reply" };
    expect(end.voiceNote).toEqual(note);
    expect(saved.voiceNote).toEqual(note);
    expect(finished.voiceNote).toEqual(note);
  });

  it("say a task run's report when it brought something back", async () => {
    const { saved } = await turn(TASK, [{ type: "run-report", report: { outcome: "update", summary: "Three roles cleared your bar." } }, { type: "message", text: "## Roles\n\nDetails." }]);
    expect(saved.voiceNote).toEqual({ script: "Three roles cleared your bar.", source: "summary" });
    const quiet = await turn(TASK, [{ type: "run-report", report: { outcome: "nothing_new", summary: "Nothing" } }, { type: "message", text: "Nothing new." }]);
    expect(quiet.saved.voiceNote ?? null).toBeNull();
  });

  it("don't come back for typing, a call, a failed run, or a member without voice", async () => {
    for (const origin of [null, { kind: "voice" } as const]) {
      expect((await turn(origin, [{ type: "message", text: "Done." }])).saved.voiceNote ?? null).toBeNull();
    }
    const failed = await turn(VOICE_MESSAGE, [{ type: "text-delta", text: "Half" }], { fail: new AgentError("Boom") });
    expect(failed.saved).toMatchObject({ status: "error" });
    expect(failed.saved.voiceNote ?? null).toBeNull();
    const off = await turn(VOICE_MESSAGE, [{ type: "message", text: "Done." }], { voiceNotes: false });
    expect(off.end.voiceNote ?? null).toBeNull();
    expect(off.saved.voiceNote ?? null).toBeNull();
  });

  it("after the member decides on an approval, say what the reply went on to say, not what they read before deciding", async () => {
    const asked = "Here's the reply to Jo. It's waiting for your OK below.";
    for (const [decision, resumed, script] of [
      ["approve", "Sent it. Jo will see it in a minute.", "Sent it. Jo will see it in a minute."],
      ["reject", "Okay, I won't send it.", "Okay, I won't send it."],
      ["approve", "", null],
    ] as const) {
      const store = createMemoryStore(scopeA);
      const id = crypto.randomUUID();
      const adapter: AgentAdapter = {
        ...scripted([]),
        discard: async () => {},
        async *run(input) {
          if (!input.resume) {
            yield { type: "text-delta", text: asked };
            yield { type: "approval", summary: "Send the reply to Jo", app: "gmail", details: [], state: { jobId: "job-1" } };
            return;
          }
          if (resumed) yield { type: "text-delta", text: resumed };
        },
      };
      const deps = { store, adapter, context: context(scopeA), idleTimeoutMs: 1000, voice: true, voiceNotes: true };
      const first = await collect(startTurn(deps, { conversationId: id, kind: "send", text: "Reply to Jo for me", origin: VOICE_MESSAGE }));
      const approval = first.find((e) => e.type === "approval");
      if (approval?.type !== "approval") throw new Error("no approval");
      // Nothing to hear while it waits on the member.
      expect((await store.listMessages(id))[1].voiceNote ?? null).toBeNull();
      const events = await collect(startTurn(deps, { conversationId: id, kind: "decide", approvalId: approval.approval.id, decision }));
      const end = events.at(-1);
      if (end?.type !== "end") throw new Error("no end event");
      const note = script ? { script, source: "reply" } : null;
      expect(end.message.voiceNote ?? null).toEqual(note);
      expect((await store.listMessages(id))[1].voiceNote ?? null).toEqual(note);
    }
  });

  it("come back on a reply to words said on a call, once the member has hung up on it", async () => {
    const onCall = { kind: "voice", sessionId: "s1" } as const;
    for (const [over, expected] of [
      [true, { script: "Found three. The best is remote.", source: "reply" }],
      [false, null],
    ] as const) {
      const store = createMemoryStore(scopeA);
      const id = crypto.randomUUID();
      const callEnded = vi.fn(async () => over);
      const events = await collect(
        startTurn(
          { store, adapter: scripted([{ type: "message", text: "Found three. The best is remote." }]), context: context(scopeA), idleTimeoutMs: 1000, voice: true, voiceNotes: true, callEnded },
          { conversationId: id, kind: "send", text: "Find me roles", origin: onCall },
        ),
      );
      expect(callEnded).toHaveBeenCalledWith("s1");
      const end = events.at(-1);
      expect(end?.type === "end" && (end.message.voiceNote ?? null)).toEqual(expected);
    }
    // A member without voice notes gets none, and the call isn't even checked.
    {
      const store = createMemoryStore(scopeA);
      const id = crypto.randomUUID();
      const callEnded = vi.fn(async () => true);
      await collect(
        startTurn(
          { store, adapter: scripted([{ type: "message", text: "Done." }]), context: context(scopeA), idleTimeoutMs: 1000, voiceNotes: false, callEnded },
          { conversationId: id, kind: "send", text: "Find me roles", origin: onCall },
        ),
      );
      expect(callEnded).not.toHaveBeenCalled();
      expect((await store.listMessages(id))[1].voiceNote ?? null).toBeNull();
    }
    // A call it can't check isn't taken as over, and doesn't stop the reply being saved.
    {
      const store = createMemoryStore(scopeA);
      const id = crypto.randomUUID();
      const callEnded = vi.fn(async () => {
        throw new Error("db");
      });
      const events = await collect(
        startTurn(
          { store, adapter: scripted([{ type: "message", text: "Found three. The best is remote." }]), context: context(scopeA), idleTimeoutMs: 1000, voice: true, voiceNotes: true, callEnded },
          { conversationId: id, kind: "send", text: "Find me roles", origin: onCall },
        ),
      );
      expect(callEnded).toHaveBeenCalledWith("s1");
      const end = events.at(-1);
      if (end?.type !== "end") throw new Error("no end event");
      expect(end.message.status).toBe("complete");
      expect(end.message.voiceNote ?? null).toBeNull();
      const saved = (await store.listMessages(id))[1];
      expect(saved).toMatchObject({ status: "complete", content: "Found three. The best is remote." });
      expect(saved.voiceNote ?? null).toBeNull();
    }
  });

  it("follow the member's voice message through a retry", async () => {
    const { store, id } = await turn(VOICE_MESSAGE, [{ type: "message", text: "First try." }]);
    const events = await collect(
      startTurn({ store, adapter: scripted([{ type: "message", text: "Second try." }]), context: context(scopeA), idleTimeoutMs: 1000, voice: true, voiceNotes: true }, { conversationId: id, kind: "retry" }),
    );
    const end = events.at(-1);
    expect(end?.type === "end" && end.message.voiceNote).toEqual({ script: "Second try.", source: "reply" });
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

describe("keep going", () => {
  const more = [{ type: "text-delta", text: "Labeled the first 200." }, { type: "keep-going", remaining: "label  the other\n400" }] as AgentEvent[];
  const deps = (events: AgentEvent[], seen?: AgentRunInput[]) => ({
    store: createMemoryStore(scopeA),
    adapter: scripted(events, undefined, seen),
    context: context(scopeA),
    idleTimeoutMs: 1000,
  });

  it("saves what's left on a reply that finished with more to do, and carries it on with no message of the member's", async () => {
    const seen: AgentRunInput[] = [];
    const d = deps(more, seen);
    const id = crypto.randomUUID();
    const end = (await collect(startTurn(d, { conversationId: id, kind: "send", text: "Tag my inbox" }))).at(-1);
    expect(end?.type === "end" && end.message.keepGoing).toBe("label the other 400");
    expect((await d.store.listMessages(id)).at(-1)?.keepGoing).toBe("label the other 400");

    await collect(startTurn(d, { conversationId: id, kind: "continue" }));
    expect(seen.at(-1)?.message).toBe(renderContinueMessage("label the other 400"));
    const messages = await d.store.listMessages(id);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
  });

  it("carries nothing on without the reply saying so, after the member's own message, or past the cap", async () => {
    const plain = deps([{ type: "text-delta", text: "All done." }] as AgentEvent[]);
    const id = crypto.randomUUID();
    await collect(startTurn(plain, { conversationId: id, kind: "send", text: "Tag my inbox" }));
    await expect(startTurn(plain, { conversationId: id, kind: "continue" })).rejects.toMatchObject({ status: 409 });
    await expect(startTurn(plain, { conversationId: crypto.randomUUID(), kind: "continue" })).rejects.toMatchObject({ status: 409 });

    const long = deps(more);
    const chain = crypto.randomUUID();
    await collect(startTurn(long, { conversationId: chain, kind: "send", text: "Tag my inbox" }));
    for (let i = 0; i < MAX_KEEP_GOING - 1; i++) await collect(startTurn(long, { conversationId: chain, kind: "continue" }));
    // The last reply allowed in a row doesn't say it carries on, so nothing waits on it.
    const last = (await collect(startTurn(long, { conversationId: chain, kind: "continue" }))).at(-1);
    expect(last?.type === "end" && last.message.keepGoing).toBeUndefined();
    await expect(startTurn(long, { conversationId: chain, kind: "continue" })).rejects.toMatchObject({ status: 409 });
  });

  it("carries a reply on once when the page and the worker both try", async () => {
    const seen: AgentRunInput[] = [];
    const db = createMemoryDb();
    const id = crypto.randomUUID();
    // The page and the worker reach different server instances, sharing only the database.
    const page = { ...deps(more, seen), store: createMemoryStore(scopeA, db) };
    const worker = { ...deps(more, seen), store: createMemoryStore(scopeA, db) };
    await collect(startTurn(page, { conversationId: id, kind: "send", text: "Tag my inbox" }));

    const tries = await Promise.allSettled([page, worker].map((d) => collect(startTurn(d, { conversationId: id, kind: "continue" }))));
    expect(tries.filter((t) => t.status === "fulfilled")).toHaveLength(1);
    expect(tries.find((t) => t.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect((await page.store.listMessages(id)).map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(seen.filter((s) => s.message === renderContinueMessage("label the other 400"))).toHaveLength(1);

    // A reply already taken elsewhere (by the worker, or ended by the member's Stop) isn't carried on again.
    expect(await worker.store.claimKeepGoing(id)).toBe(true);
    await expect(startTurn(page, { conversationId: id, kind: "continue" })).rejects.toMatchObject({ status: 409 });
    expect((await page.store.listMessages(id)).at(-1)?.keepGoing).toBeUndefined();
  });

  it("doesn't carry on a reply that asked the member something", async () => {
    const asking = deps([...more, { type: "questions", questions: [{ id: "q1", question: "Which label?", options: ["A", "B"] }] }] as AgentEvent[]);
    const id = crypto.randomUUID();
    const end = (await collect(startTurn(asking, { conversationId: id, kind: "send", text: "Tag my inbox" }))).at(-1);
    expect(end?.type === "end" && end.message.keepGoing).toBeUndefined();
  });

  it("carries on a reply whose time ran out even when the agent didn't say so", async () => {
    const seen: AgentRunInput[] = [];
    const cut = [{ type: "out-of-time" }, { type: "text-delta", text: "Nothing is tagged yet. Tell me to carry on." }] as AgentEvent[];
    const d = deps(cut, seen);
    const id = crypto.randomUUID();
    const end = (await collect(startTurn(d, { conversationId: id, kind: "send", text: "Tag my inbox" }))).at(-1);
    expect(end?.type === "end" && end.message.keepGoing).toBeTruthy();
    await collect(startTurn(d, { conversationId: id, kind: "continue" }));
    expect(seen.at(-1)?.message).toMatch(/smaller pieces/);

    // Not when it left the member a card to answer.
    const form = deps([...cut, { type: "ui", block: { form: { title: "Labels", fields: [{ id: "a", label: "Label", type: "text" }] } } }] as AgentEvent[]);
    const asked = (await collect(startTurn(form, { conversationId: crypto.randomUUID(), kind: "send", text: "Tag my inbox" }))).at(-1);
    expect(asked?.type === "end" && asked.message.ui?.length).toBeTruthy();
    expect(asked?.type === "end" && asked.message.keepGoing).toBeUndefined();
  });

  it("carries on a reply the request's own time limit cut off", async () => {
    const store = createMemoryStore(scopeA);
    const slow: AgentAdapter = {
      ...scripted([]),
      async *run({ signal }) {
        yield { type: "text-delta", text: "Read the first 300." };
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      },
    };
    const id = crypto.randomUUID();
    const end = (await collect(startTurn({ store, adapter: slow, context: context(scopeA), idleTimeoutMs: 5000, deadline: Date.now() + 30 }, { conversationId: id, kind: "send", text: "Tag my inbox" }))).at(-1);
    if (end?.type !== "end") throw new Error("no end");
    expect(end.message).toMatchObject({ status: "error", error: expect.stringMatching(/carries on in the next one/) });
    expect(end.message.keepGoing).toBeTruthy();
    const next = await collect(startTurn({ store, adapter: scripted([{ type: "text-delta", text: "Done." }]), context: context(scopeA), idleTimeoutMs: 1000 }, { conversationId: id, kind: "continue" }));
    expect(next.at(-1)).toMatchObject({ type: "end", message: { status: "complete" } });
  });
});

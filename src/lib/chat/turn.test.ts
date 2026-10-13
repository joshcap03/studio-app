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

const caps = { streaming: true, cancellation: "abort", toolEvents: true, artifacts: true, runStatus: false } as const;

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

describe("mock adapter", () => {
  it("emits a single message in non-streaming mode", async () => {
    const adapter = createMockAdapter({ streaming: false, pace: 0 });
    const events: AgentEvent[] = [];
    for await (const e of adapter.run({ conversationId: "c", threadId: null, message: "help", history: [], tenant: context(scopeA), signal: signal() })) events.push(e);
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

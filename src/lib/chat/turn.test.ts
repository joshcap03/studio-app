import { describe, expect, it } from "vitest";
import { createMockAdapter } from "@/lib/agent/mock";
import { AgentError, type AgentAdapter, type AgentEvent } from "@/lib/agent/types";
import { readNdjson } from "@/lib/client/api";
import { createStore } from "@/lib/db/store";
import { openDatabase } from "@/lib/db/sqlite";
import type { StreamEvent } from "@/lib/types";
import { sanitizeArtifact, startTurn, titleFromMessage, TurnError, withLiveStatus } from "./turn";

const USER = "owner";

function setup() {
  const store = createStore(openDatabase(":memory:"));
  store.ensureUser(USER);
  return store;
}

function scripted(events: AgentEvent[], fail?: AgentError): AgentAdapter {
  return {
    id: "scripted",
    live: true,
    label: "Scripted",
    async *run() {
      for (const e of events) yield e;
      if (fail) throw fail;
    },
  };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  await readNdjson<StreamEvent>(stream, (e) => events.push(e));
  return events;
}

describe("startTurn", () => {
  it("streams and persists a complete turn, creating the conversation", async () => {
    const store = setup();
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
      startTurn({ store, adapter, idleTimeoutMs: 1000 }, { userId: USER, conversationId: id, kind: "send", text: "Hi" }, new AbortController().signal),
    );

    expect(events[0].type).toBe("start");
    const end = events.at(-1);
    expect(end?.type).toBe("end");
    if (end?.type !== "end") throw new Error("no end event");
    expect(end.message).toMatchObject({ status: "complete", content: "Hello there" });
    expect(end.message.activity).toHaveLength(1);
    expect(end.message.activity[0]).toMatchObject({ label: "Read", status: "done" });

    const saved = store.listMessages(id);
    expect(saved.map((m) => [m.role, m.content, m.status])).toEqual([
      ["user", "Hi", "complete"],
      ["assistant", "Hello there", "complete"],
    ]);
    expect(saved[1].artifacts[0].title).toBe("Sheet");
    expect(store.getConversation(USER, id)).toMatchObject({ title: "Hi", agentThreadId: "t-1" });
  });

  it("passes the stored thread id and prior turns to the adapter", async () => {
    const store = setup();
    const id = crypto.randomUUID();
    const seen: { threadId: string | null; history: unknown[] }[] = [];
    const adapter: AgentAdapter = {
      id: "spy",
      live: true,
      label: "Spy",
      async *run(input) {
        seen.push({ threadId: input.threadId, history: input.history });
        yield { type: "thread", threadId: "t-9" };
        yield { type: "message", text: `echo ${input.message}` };
      },
    };
    const deps = { store, adapter, idleTimeoutMs: 1000 };
    await collect(startTurn(deps, { userId: USER, conversationId: id, kind: "send", text: "one" }, new AbortController().signal));
    await collect(startTurn(deps, { userId: USER, conversationId: id, kind: "send", text: "two" }, new AbortController().signal));

    expect(seen[0]).toEqual({ threadId: null, history: [] });
    expect(seen[1]).toEqual({
      threadId: "t-9",
      history: [
        { role: "user", content: "one" },
        { role: "assistant", content: "echo one" },
      ],
    });
  });

  it("records an agent failure with its user-safe message, and retry replaces it", async () => {
    const store = setup();
    const id = crypto.randomUUID();
    const failing = scripted([{ type: "text-delta", text: "partial" }], new AgentError("Shopify timed out."));
    const events = await collect(
      startTurn({ store, adapter: failing, idleTimeoutMs: 1000 }, { userId: USER, conversationId: id, kind: "send", text: "go" }, new AbortController().signal),
    );
    const end = events.at(-1);
    expect(end?.type === "end" && end.message).toMatchObject({ status: "error", error: "Shopify timed out." });

    const ok = scripted([{ type: "message", text: "worked" }]);
    await collect(startTurn({ store, adapter: ok, idleTimeoutMs: 1000 }, { userId: USER, conversationId: id, kind: "retry" }, new AbortController().signal));
    expect(store.listMessages(id).map((m) => [m.role, m.content, m.status])).toEqual([
      ["user", "go", "complete"],
      ["assistant", "worked", "complete"],
    ]);
  });

  it("fails a run that goes quiet past the idle timeout", async () => {
    const store = setup();
    const hanging: AgentAdapter = {
      id: "hang",
      live: true,
      label: "Hang",
      async *run({ signal }) {
        yield { type: "text-delta", text: "…" };
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      },
    };
    const events = await collect(
      startTurn({ store, adapter: hanging, idleTimeoutMs: 30 }, { userId: USER, conversationId: crypto.randomUUID(), kind: "send", text: "go" }, new AbortController().signal),
    );
    const end = events.at(-1);
    expect(end?.type === "end" && end.message.status).toBe("error");
    expect(end?.type === "end" && end.message.error).toMatch(/stopped responding/);
  });

  it("marks a run stopped when the request is aborted and keeps partial text", async () => {
    const store = setup();
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const slow = createMockAdapter({ streaming: true, pace: 1 });
    const stream = startTurn({ store, adapter: slow, idleTimeoutMs: 5000, checkpointMs: 0 }, { userId: USER, conversationId: id, kind: "send", text: "help with operations" }, controller.signal);
    const reader = stream.getReader();
    // Read until some text has arrived, then stop.
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes('"type":"text"')) seen += decoder.decode((await reader.read()).value);
    controller.abort();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 50));
    const assistant = store.listMessages(id)[1];
    expect(assistant.status).toBe("stopped");
    expect(assistant.content.length).toBeGreaterThan(0);
  });

  it("refuses a second concurrent run in the same conversation", async () => {
    const store = setup();
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const stream = startTurn(
      { store, adapter: createMockAdapter({ streaming: true }), idleTimeoutMs: 5000 },
      { userId: USER, conversationId: id, kind: "send", text: "hello" },
      controller.signal,
    );
    expect(() =>
      startTurn({ store, adapter: createMockAdapter({ streaming: true }), idleTimeoutMs: 5000 }, { userId: USER, conversationId: id, kind: "send", text: "again" }, new AbortController().signal),
    ).toThrow(TurnError);
    controller.abort();
    await stream.cancel();
  });

  it("does not let one user reach another user's conversation", async () => {
    const store = setup();
    store.ensureUser("intruder");
    const id = crypto.randomUUID();
    await collect(startTurn({ store, adapter: scripted([{ type: "message", text: "x" }]), idleTimeoutMs: 1000 }, { userId: USER, conversationId: id, kind: "send", text: "mine" }, new AbortController().signal));
    expect(() =>
      startTurn({ store, adapter: scripted([]), idleTimeoutMs: 1000 }, { userId: "intruder", conversationId: id, kind: "retry" }, new AbortController().signal),
    ).toThrow(TurnError);
    expect(store.getConversation("intruder", id)).toBeNull();
    expect(store.deleteConversation("intruder", id)).toBe(false);
  });
});

describe("mock adapter", () => {
  it("emits a single message in non-streaming mode", async () => {
    const adapter = createMockAdapter({ streaming: false, pace: 0 });
    const events: AgentEvent[] = [];
    for await (const e of adapter.run({ threadId: null, message: "help", history: [], signal: new AbortController().signal })) events.push(e);
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

  it("shows orphaned streaming messages as interrupted", () => {
    const m = { id: "m", conversationId: "c", role: "assistant" as const, content: "", status: "streaming" as const, activity: [], artifacts: [], createdAt: 0 };
    expect(withLiveStatus([m], "not-running")[0].status).toBe("interrupted");
  });

  it("builds short titles", () => {
    expect(titleFromMessage("  Hello\n world ")).toBe("Hello world");
    const long = titleFromMessage("word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("store search", () => {
  it("matches titles and message contents, escaping LIKE wildcards", async () => {
    const store = setup();
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await collect(startTurn({ store, adapter: scripted([{ type: "message", text: "huggie hoops are low" }]), idleTimeoutMs: 1000 }, { userId: USER, conversationId: a, kind: "send", text: "inventory" }, new AbortController().signal));
    await collect(startTurn({ store, adapter: scripted([{ type: "message", text: "ok" }]), idleTimeoutMs: 1000 }, { userId: USER, conversationId: b, kind: "send", text: "100% margin" }, new AbortController().signal));
    expect(store.listConversations(USER, "huggie").map((c) => c.id)).toEqual([a]);
    expect(store.listConversations(USER, "100%").map((c) => c.id)).toEqual([b]);
    expect(store.listConversations(USER, "%")).toHaveLength(1);
  });
});

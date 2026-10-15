import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tenant } from "@/lib/tenant";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ supermemory: { apiKey: "sm_test", baseUrl: "https://sm.example" } }),
}));

const { forget, listMemories, namespaceFor, parseMemoryId, recall, recallQuery, remember, replaceMemory } = await import("./memory");

const WS = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const tenant = (role: "owner" | "member" = "member") =>
  ({ workspace: { id: WS, name: "Acme", role }, userId: USER }) as unknown as Tenant;

type Call = { url: string; method: string; body: unknown; auth: string | null };
let calls: Call[];
let reply: (call: Call) => Response;

beforeEach(() => {
  calls = [];
  reply = () => Response.json({});
  vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
    const call = {
      url: url.toString(),
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body as string) : undefined,
      auth: new Headers(init.headers).get("authorization"),
    };
    calls.push(call);
    return reply(call);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("memory namespaces", () => {
  it("keeps each workspace, and each member's personal memory, in its own namespace", () => {
    expect(namespaceFor(tenant(), "workspace")).toBe(`ws_${WS}`);
    expect(namespaceFor(tenant(), "personal")).toBe(`ws_${WS}_u_${USER}`);
    expect(namespaceFor({ ...tenant(), workspace: { id: "other", name: "", role: "owner" } }, "workspace")).not.toBe(`ws_${WS}`);
  });

  it("only accepts memory ids that name their scope", () => {
    expect(parseMemoryId("personal:abc_123")).toEqual({ scope: "personal", documentId: "abc_123" });
    expect(parseMemoryId("abc")).toBeNull();
    expect(parseMemoryId("workspace:../x")).toBeNull();
    expect(parseMemoryId("ns:abc")).toBeNull();
  });
});

describe("remember", () => {
  it("saves into the caller's namespace for instant recall", async () => {
    reply = () => Response.json({ id: "doc1", status: "queued" });
    const memory = await remember(tenant(), "  Ships on   Tuesdays. ", "personal");
    expect(calls[0]).toMatchObject({
      url: `https://sm.example/ns/ws_${WS}_u_${USER}/document`,
      method: "POST",
      auth: "Bearer sm_test",
      body: { content: "Ships on Tuesdays.", dreaming: "instant", metadata: { text: "Ships on Tuesdays.", createdBy: USER } },
    });
    expect(memory).toMatchObject({ id: "personal:doc1", content: "Ships on Tuesdays.", scope: "personal", mine: true, category: "other", pinned: false });
  });

  it("keeps the category, pin, and the message it came from as flat metadata", async () => {
    reply = () => Response.json({ id: "doc2" });
    const source = { conversationId: "c1", messageId: "m1" };
    const memory = await remember(tenant(), "Acme supplies clasps.", "workspace", { category: "suppliers", pinned: true, source });
    expect(calls[0].body).toMatchObject({
      metadata: { category: "suppliers", pinned: true, sourceConversation: "c1", sourceMessage: "m1", createdBy: USER },
    });
    expect(memory).toMatchObject({ category: "suppliers", pinned: true, source });
  });

  it("files an unknown category under Other", async () => {
    reply = () => Response.json({ id: "doc3" });
    await remember(tenant(), "x", "workspace", { category: "nonsense" as never });
    expect(calls[0].body).toMatchObject({ metadata: { category: "other" } });
  });
});

describe("replaceMemory", () => {
  it("saves the edited fact under its original author, time, and source, then removes the old one", async () => {
    reply = (call) => {
      if (call.method === "GET")
        return Response.json({
          id: "w1",
          metadata: { text: "Old", createdBy: USER, category: "team", savedAt: 1000, sourceConversation: "c1", sourceMessage: "m1" },
        });
      if (call.method === "POST") return Response.json({ id: "w2" });
      return Response.json({ count: 1 });
    };
    const memory = await replaceMemory(tenant(), "workspace:w1", { content: "New", pinned: true });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "DELETE"]);
    expect(calls[1].body).toMatchObject({
      content: "New",
      metadata: { createdBy: USER, category: "team", pinned: true, savedAt: 1000, sourceConversation: "c1", sourceMessage: "m1" },
    });
    expect(calls[2].body).toEqual({ ids: ["w1"] });
    expect(memory).toMatchObject({ id: "workspace:w2", content: "New", pinned: true, createdAt: 1000, mine: true });
  });

  it("refuses a member editing a shared fact someone else saved", async () => {
    reply = () => Response.json({ id: "w1", metadata: { text: "x", createdBy: "someone-else" } });
    await expect(replaceMemory(tenant(), "workspace:w1", { pinned: true })).rejects.toMatchObject({ status: 403 });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("keeps the original author when an owner edits someone else's fact", async () => {
    reply = (call) =>
      call.method === "GET" ? Response.json({ id: "w1", metadata: { text: "x", createdBy: "someone-else" } }) : Response.json({ id: "w2", count: 1 });
    const memory = await replaceMemory(tenant("owner"), "workspace:w1", { category: "voice" });
    expect(calls[1].body).toMatchObject({ metadata: { createdBy: "someone-else", category: "voice" } });
    expect(memory?.mine).toBe(false);
  });
});

describe("listMemories", () => {
  it("lists shared and personal memory, newest first, marking what the caller saved", async () => {
    reply = (call) =>
      Response.json({
        documents: call.url.includes("_u_")
          ? [{ id: "p1", metadata: { text: "Likes bullets" }, system: { createdAt: "2026-10-02T00:00:00Z" } }]
          : [
              { id: "w1", metadata: { text: "Fiscal year starts in Feb", createdBy: "someone-else" }, system: { createdAt: "2026-10-01T00:00:00Z" } },
              { id: "w2", metadata: { text: "Main supplier is Acme", createdBy: USER }, system: { createdAt: "2026-10-03T00:00:00Z" } },
            ],
      });
    const list = await listMemories(tenant());
    expect(list.map((m) => [m.id, m.mine])).toEqual([
      ["workspace:w2", true],
      ["personal:p1", true],
      ["workspace:w1", false],
    ]);
  });
});

describe("forget", () => {
  it("lets a member remove only shared memories they saved", async () => {
    reply = (call) => (call.method === "GET" ? Response.json({ id: "w1", metadata: { createdBy: "someone-else" } }) : Response.json({ count: 1, errors: [] }));
    await expect(forget(tenant(), "workspace:w1")).rejects.toMatchObject({ status: 403 });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("lets an owner remove any shared memory, and anyone remove their own personal ones", async () => {
    reply = () => Response.json({ count: 1, errors: [] });
    await expect(forget(tenant("owner"), "workspace:w1")).resolves.toBe(true);
    await expect(forget(tenant(), "personal:p1")).resolves.toBe(true);
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["DELETE", `https://sm.example/ns/ws_${WS}/document`, { ids: ["w1"] }],
      ["DELETE", `https://sm.example/ns/ws_${WS}_u_${USER}/document`, { ids: ["p1"] }],
    ]);
  });
});

describe("recallQuery", () => {
  it("uses the member's last few messages, newest first", () => {
    expect(recallQuery(["hi", "find t-shirt blanks", "  ", "any that sell to resellers?"], 2)).toBe("any that sell to resellers?\nfind t-shirt blanks");
    expect(recallQuery([" "])).toBeUndefined();
  });
});

describe("recall", () => {
  it("puts matches for the message first, then the standing profile, without repeats", async () => {
    reply = (call) => {
      const personal = call.url.includes("_u_");
      if (call.url.endsWith("/search")) return Response.json({ results: personal ? [] : [{ memory: "Ships on Tuesdays" }] });
      return Response.json({
        profile: personal
          ? { static: [{ id: "a", memory: "Prefers short replies" }], dynamic: [], buckets: {} }
          : { static: [{ id: "b", memory: "ships on tuesdays" }, { id: "c", memory: "Sells jewelry" }], dynamic: [], buckets: {} },
      });
    };
    expect(await recall(tenant(), "when do we ship?")).toEqual(["Ships on Tuesdays", "Sells jewelry", "Prefers short replies"]);
    expect(calls.filter((c) => c.url.endsWith("/search")).map((c) => c.body)).toEqual([
      { query: "when do we ship?", searchMode: "memories", limit: 6 },
      { query: "when do we ship?", searchMode: "memories", limit: 6 },
    ]);
  });

  it("puts pinned facts first when asked, and only lists them then", async () => {
    reply = (call) => {
      if (call.url.includes("/list/documents"))
        return Response.json({
          documents: call.url.includes("_u_")
            ? []
            : [
                { id: "w1", metadata: { text: "Never discount bridal", pinned: true } },
                { id: "w2", metadata: { text: "Not pinned" } },
              ],
        });
      if (call.url.endsWith("/search")) return Response.json({ results: [{ memory: "Ships on Tuesdays" }] });
      return Response.json({ profile: { static: [], dynamic: [] } });
    };
    expect(await recall(tenant(), "hi", { pinned: true })).toEqual(["Never discount bridal", "Ships on Tuesdays"]);
    calls = [];
    await recall(tenant(), "hi");
    expect(calls.some((c) => c.url.includes("/list/documents"))).toBe(false);
  });

  it("answers without memory when Supermemory fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    reply = () => new Response("down", { status: 500 });
    expect(await recall(tenant(), "hi")).toEqual([]);
    error.mockRestore();
  });
});

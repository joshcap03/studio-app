import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tenant } from "@/lib/tenant-core";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ supermemory: { apiKey: "sm_test", baseUrl: "https://sm.example" } }),
}));

const { forget, forgetConversations, listMemories, moveLegacyPersonal, namespaceFor, parseMemoryId, recall, recallQuery, remember, replaceMemory, resetMoves } = await import("./memory");

const WS = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const tenant = (role: "owner" | "member" = "member") =>
  ({ workspace: { id: WS, name: "Acme", role }, userId: USER }) as unknown as Tenant;

type Call = { url: string; method: string; body: unknown; auth: string | null };
/** Which namespace a call went to. */
const where = (call: Call) =>
  call.url.includes(`/ns/u_${USER}/`) ? "personal" : call.url.includes(`/ns/ws_${WS}_u_${USER}/`) ? "legacy" : "workspace";
let calls: Call[];
let reply: (call: Call) => Response;

beforeEach(() => {
  resetMoves();
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
  it("keeps each workspace's shared memory in its own namespace, and a person's in theirs, across agents", () => {
    const other = { ...tenant(), workspace: { id: "other", name: "", role: "owner" as const } };
    expect(namespaceFor(tenant(), "workspace")).toBe(`ws_${WS}`);
    expect(namespaceFor(other, "workspace")).not.toBe(`ws_${WS}`);
    expect(namespaceFor(tenant(), "personal")).toBe(`u_${USER}`);
    expect(namespaceFor(other, "personal")).toBe(`u_${USER}`);
    expect(namespaceFor(tenant(), "legacy")).toBe(`ws_${WS}_u_${USER}`);
  });

  it("only accepts memory ids that name their scope", () => {
    expect(parseMemoryId("personal:abc_123")).toEqual({ scope: "personal", where: "personal", documentId: "abc_123" });
    expect(parseMemoryId("legacy:abc_123")).toEqual({ scope: "personal", where: "legacy", documentId: "abc_123" });
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
      url: `https://sm.example/ns/u_${USER}/document`,
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
        documents: where(call) === "legacy" ? [] : where(call) === "personal"
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
      ["DELETE", `https://sm.example/ns/u_${USER}/document`, { ids: ["p1"] }],
    ]);
  });
});

describe("forgetConversations", () => {
  const C1 = "c1111111-1111-4111-8111-111111111111";

  it("forgets what was saved from those chats: the caller's shared facts and their personal ones", async () => {
    reply = (call) =>
      call.url.includes("/list/documents")
        ? Response.json({ documents: where(call) === "legacy" ? [] : [{ id: `${where(call)}-1` }] })
        : Response.json({ count: 1, errors: [] });
    await expect(forgetConversations(tenant(), [C1])).resolves.toBe(2);
    const fromC1 = { operator: "or", operands: [{ field: "sourceConversation", operator: "eq", value: C1 }] };
    const lists = calls.filter((c) => c.url.includes("/list/documents"));
    expect(lists.map((c) => [where(c), (c.body as { filter: unknown }).filter])).toEqual([
      ["workspace", { operator: "and", operands: [fromC1, { field: "createdBy", operator: "eq", value: USER }] }],
      ["personal", fromC1],
      ["legacy", fromC1],
    ]);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => [where(c), c.body])).toEqual([
      ["workspace", { ids: ["workspace-1"] }],
      ["personal", { ids: ["personal-1"] }],
    ]);
  });

  it("reads on until every page is gone", async () => {
    let pages = 2;
    reply = (call) =>
      call.url.includes("/list/documents")
        ? Response.json({ documents: where(call) === "personal" && pages-- > 0 ? Array.from({ length: 100 }, (_, i) => ({ id: `p${pages}-${i}` })) : [] })
        : Response.json({ count: (call.body as { ids: string[] }).ids.length });
    await expect(forgetConversations(tenant(), [C1])).resolves.toBe(200);
  });

  it("does nothing without conversations", async () => {
    await expect(forgetConversations(tenant(), [])).resolves.toBe(0);
    expect(calls).toHaveLength(0);
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
      if (where(call) === "legacy") return call.url.includes("/list/") ? Response.json({ documents: [] }) : Response.json({});
      const personal = where(call) === "personal";
      if (call.url.endsWith("/search")) return Response.json({ results: personal ? [] : [{ memory: "Ships on Tuesdays" }] });
      return Response.json({
        profile: personal
          ? { static: [{ id: "a", memory: "Prefers short replies" }], dynamic: [], buckets: {} }
          : { static: [{ id: "b", memory: "ships on tuesdays" }, { id: "c", memory: "Sells jewelry" }], dynamic: [], buckets: {} },
      });
    };
    expect(await recall(tenant(), "when do we ship?")).toEqual(["Ships on Tuesdays", "Sells jewelry", "Prefers short replies"]);
    expect(calls.filter((c) => c.url.endsWith("/search") && where(c) !== "legacy").map((c) => c.body)).toEqual([
      { query: "when do we ship?", searchMode: "memories", limit: 6 },
      { query: "when do we ship?", searchMode: "memories", limit: 6 },
    ]);
  });

  it("puts pinned facts first when asked, and only lists them then", async () => {
    reply = (call) => {
      if (call.url.includes("/list/documents"))
        return Response.json({
          documents: where(call) !== "workspace"
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

describe("moving personal memory out of the workspace", () => {
  const legacyDoc = {
    id: "old1",
    metadata: { text: "Prefers mornings", createdBy: USER, category: "voice", pinned: true, savedAt: 500, sourceConversation: "c1", sourceMessage: "m1" },
  };

  it("copies each old personal fact into the person's own namespace, keeping its details, then removes the old copy", async () => {
    let legacy = [legacyDoc];
    reply = (call) => {
      if (call.url.includes("/list/")) return Response.json({ documents: where(call) === "legacy" ? legacy : [] });
      if (call.method === "POST") return Response.json({ id: "new1" });
      if (call.method === "DELETE") {
        legacy = [];
        return Response.json({ count: 1 });
      }
      return Response.json({});
    };
    await moveLegacyPersonal(tenant());
    const saved = calls.find((c) => c.method === "POST" && c.url.endsWith("/document"))!;
    expect(where(saved)).toBe("personal");
    expect(saved.body).toMatchObject({
      content: "Prefers mornings",
      metadata: { createdBy: USER, category: "voice", pinned: true, savedAt: 500, sourceConversation: "c1", sourceMessage: "m1", movedFrom: "old1" },
    });
    const removed = calls.find((c) => c.method === "DELETE")!;
    expect([where(removed), removed.body]).toEqual(["legacy", { ids: ["old1"] }]);

    // Done once per process: no more calls.
    calls = [];
    await moveLegacyPersonal(tenant());
    expect(calls).toEqual([]);
  });

  it("doesn't copy a fact twice when an earlier move stopped before removing the old copy", async () => {
    let legacy = [legacyDoc];
    reply = (call) => {
      if (call.url.includes("/list/"))
        return Response.json({ documents: where(call) === "legacy" ? legacy : [{ id: "new1", metadata: { text: "Prefers mornings", movedFrom: "old1" } }] });
      if (call.method === "DELETE") {
        legacy = [];
        return Response.json({ count: 1 });
      }
      return Response.json({ id: "dup" });
    };
    await moveLegacyPersonal(tenant());
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/document"))).toBe(false);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => where(c))).toEqual(["legacy"]);
  });

  it("keeps the old copy, and still lists it, if copying fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    reply = (call) => {
      if (call.url.includes("/list/")) return Response.json({ documents: where(call) === "legacy" ? [legacyDoc] : [] });
      if (call.method === "POST") return new Response("down", { status: 500 });
      return Response.json({ count: 1 });
    };
    const list = await listMemories(tenant());
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(list.map((m) => [m.id, m.scope])).toEqual([["legacy:old1", "personal"]]);
    error.mockRestore();
  });

  it("recalls old personal facts while the move hasn't finished", async () => {
    reply = (call) => {
      if (call.url.endsWith("/profile"))
        return Response.json({ profile: { static: where(call) === "legacy" ? [{ memory: "Prefers mornings" }] : [], dynamic: [] } });
      if (call.url.includes("/list/")) return new Response("slow", { status: 500 });
      return Response.json({ results: [] });
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await recall(tenant(), "hi")).toEqual(["Prefers mornings"]);
    error.mockRestore();
  });
});

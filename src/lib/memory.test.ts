import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tenant } from "@/lib/tenant-core";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ supermemory: { apiKey: "sm_test", baseUrl: "https://sm.example" } }),
}));

const {
  forget,
  forgetConversations,
  listMemories,
  mergeMemories,
  moveLegacyPersonal,
  namespaceFor,
  parseMemoryId,
  recall,
  recallQuery,
  remember,
  replaceMemory,
  resetMoves,
  unmergeMemories,
} = await import("./memory");

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

describe("mergeMemories", () => {
  /** Documents by id, as Supermemory would return them. */
  const docs: Record<string, Record<string, unknown>> = {
    w1: { text: "Sequoia counts as top tier.", createdBy: USER, category: "suppliers", savedAt: 1000, sourceConversation: "c1", sourceMessage: "m1" },
    w2: { text: "a16z counts as top tier.", createdBy: USER, category: "suppliers", savedAt: 3000, pinned: true },
    w3: { text: "Benchmark is top tier too.", createdBy: USER, category: "other", savedAt: 2000, sourceConversation: "c3", sourceMessage: "m3" },
    x1: { text: "Someone else's fact.", createdBy: "someone-else", category: "suppliers", savedAt: 500 },
    p1: { text: "Only mine.", createdBy: USER, category: "suppliers", savedAt: 100 },
  };
  beforeEach(() => {
    reply = (call) => {
      if (call.method === "GET") {
        const id = call.url.split("/").at(-1)!;
        return docs[id] ? Response.json({ id, metadata: docs[id] }) : new Response("", { status: 404 });
      }
      if (call.method === "POST") return Response.json({ id: "merged1" });
      return Response.json({ count: (call.body as { ids: string[] }).ids.length });
    };
  });

  it("saves one fact that keeps any pin, the newest time and source, and the author, then removes the originals", async () => {
    const result = await mergeMemories(tenant(), ["workspace:w1", "workspace:w2", "workspace:w3"], "Sequoia, a16z, and Benchmark count as top tier.", "suppliers");
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "GET", "POST", "DELETE"]);
    expect(calls[3]).toMatchObject({
      url: `https://sm.example/ns/ws_${WS}/document`,
      body: {
        content: "Sequoia, a16z, and Benchmark count as top tier.",
        metadata: { createdBy: USER, category: "suppliers", pinned: true, savedAt: 3000, sourceConversation: "c3", sourceMessage: "m3" },
      },
    });
    expect(calls[4].body).toEqual({ ids: ["w1", "w2", "w3"] });
    expect(result?.memory).toMatchObject({ id: "workspace:merged1", pinned: true, mine: true, createdAt: 3000 });
    expect(result?.originals.map((o) => [o.id, o.content, o.pinned, o.savedAt])).toEqual([
      ["workspace:w1", "Sequoia counts as top tier.", false, 1000],
      ["workspace:w2", "a16z counts as top tier.", true, 3000],
      ["workspace:w3", "Benchmark is top tier too.", false, 2000],
    ]);
  });

  it("files it under the topic most of them share when none is given", async () => {
    await mergeMemories(tenant(), ["workspace:w1", "workspace:w3", "workspace:w2"], "Merged.");
    expect(calls[3].body).toMatchObject({ metadata: { category: "suppliers" } });
  });

  it("never merges shared facts with ones only the member sees", async () => {
    await expect(mergeMemories(tenant(), ["workspace:w1", "personal:p1"], "x")).rejects.toMatchObject({ status: 400 });
    await expect(mergeMemories(tenant(), ["workspace:w1"], "x")).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });

  it("lets a member merge only shared facts they saved, and an owner any, crediting a mixed merge to the owner", async () => {
    await expect(mergeMemories(tenant(), ["workspace:w1", "workspace:x1"], "x")).rejects.toMatchObject({ status: 403 });
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
    calls = [];
    const result = await mergeMemories(tenant("owner"), ["workspace:w1", "workspace:x1"], "x");
    expect(calls[2].body).toMatchObject({ metadata: { createdBy: USER } });
    expect(result?.originals[1].createdBy).toBe("someone-else");
  });

  it("changes nothing when one of the facts is gone", async () => {
    await expect(mergeMemories(tenant(), ["workspace:w1", "workspace:gone"], "x")).resolves.toBeNull();
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });

  it("merges the member's personal facts, old per-workspace ones included, into their own namespace", async () => {
    await mergeMemories(tenant(), ["personal:p1", "legacy:w1"], "Both.");
    expect(calls[2].url).toBe(`https://sm.example/ns/u_${USER}/document`);
    expect(calls.slice(3).map((c) => [c.url, c.body])).toEqual([
      [`https://sm.example/ns/u_${USER}/document`, { ids: ["p1"] }],
      [`https://sm.example/ns/ws_${WS}_u_${USER}/document`, { ids: ["w1"] }],
    ]);
  });
});

describe("unmergeMemories", () => {
  const originals = [
    { id: "workspace:w1", content: "One.", scope: "workspace" as const, category: "team" as const, pinned: true, source: { conversationId: "c1", messageId: "m1" }, createdBy: "someone-else", savedAt: 1000 },
    { id: "workspace:w2", content: "Two.", scope: "workspace" as const, category: "team" as const, pinned: false, createdBy: "someone-else", savedAt: 2000 },
  ];

  it("saves the originals again as they were, then removes the merged fact", async () => {
    let n = 0;
    reply = (call) =>
      call.method === "GET" ? Response.json({ id: "m1", metadata: { text: "Merged", createdBy: USER } }) : call.method === "POST" ? Response.json({ id: `r${++n}` }) : Response.json({ count: 1 });
    const restored = await unmergeMemories(tenant("owner"), "workspace:m1", originals);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "POST", "DELETE"]);
    expect(calls[1].body).toMatchObject({
      content: "One.",
      metadata: { createdBy: "someone-else", category: "team", pinned: true, savedAt: 1000, sourceConversation: "c1", sourceMessage: "m1" },
    });
    expect(calls[3].body).toEqual({ ids: ["m1"] });
    expect(restored?.map((m) => m.id)).toEqual(["workspace:r1", "workspace:r2"]);
  });

  it("restores shared facts as the member's own when they aren't the owner", async () => {
    reply = (call) => (call.method === "GET" ? Response.json({ id: "m1", metadata: { createdBy: USER } }) : Response.json({ id: "r", count: 1 }));
    await unmergeMemories(tenant(), "workspace:m1", originals);
    expect(calls[1].body).toMatchObject({ metadata: { createdBy: USER } });
  });

  it("changes nothing when the merged fact was edited or removed since", async () => {
    reply = () => new Response("", { status: 404 });
    await expect(unmergeMemories(tenant(), "workspace:m1", originals)).resolves.toBeNull();
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
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

  it("reads past the first page, and stops if paging isn't honored or a later page fails", async () => {
    const page = (c: Call) => Number(new URL(c.url).searchParams.get("page") ?? 1);
    const rows = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, metadata: { text: `fact ${prefix}${i}` } }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    reply = (call) => {
      if (where(call) === "workspace") return Response.json({ documents: page(call) === 1 ? rows("a", 100) : page(call) === 2 ? rows("b", 30) : [] });
      // The personal scope ignores `page`: the same first page every time.
      if (where(call) === "personal") return Response.json({ documents: rows("p", 100) });
      return Response.json({ documents: [] });
    };
    const list = await listMemories(tenant());
    expect(list.filter((m) => m.scope === "workspace")).toHaveLength(130);
    expect(list.filter((m) => m.scope === "personal")).toHaveLength(100);
    expect(calls.filter((c) => where(c) === "personal" && c.url.includes("/list/"))).toHaveLength(2);

    calls = [];
    reply = (call) =>
      where(call) === "workspace" && page(call) > 1 ? new Response("down", { status: 500 }) : Response.json({ documents: where(call) === "workspace" ? rows("a", 100) : [] });
    expect(await listMemories(tenant())).toHaveLength(100);
    error.mockRestore();
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

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tenant } from "@/lib/tenant-core";
import type { Memory, MemoryMergeProposal } from "@/lib/types";

const memory = vi.hoisted(() => ({
  facts: new Map<string, unknown>(),
  getMemory: vi.fn(),
  mergeMemories: vi.fn(),
  unmergeMemories: vi.fn(),
}));
vi.mock("@/lib/memory", async (actual) => ({
  ...(await actual<typeof import("@/lib/memory")>()),
  getMemory: memory.getMemory,
  mergeMemories: memory.mergeMemories,
  unmergeMemories: memory.unmergeMemories,
}));

const { applyMerges, parseMergeRequest, resolveMergeProposal, undoMerges } = await import("./memory-merge");

const tenant = (role: "owner" | "member" = "member") => ({ workspace: { id: "ws", role }, userId: "me" }) as unknown as Tenant;
const fact = (id: string, extra: Partial<Memory> = {}): Memory => ({
  id,
  content: `Fact ${id}`,
  scope: id.startsWith("workspace:") ? "workspace" : "personal",
  createdAt: 1,
  mine: true,
  category: "suppliers",
  pinned: false,
  ...extra,
});

beforeEach(() => {
  memory.facts.clear();
  memory.getMemory.mockReset().mockImplementation(async (_t, id: string) => memory.facts.get(id) ?? null);
  memory.mergeMemories.mockReset();
  memory.unmergeMemories.mockReset();
});

describe("parseMergeRequest", () => {
  it("keeps merges with text and at least two well-formed fact ids, each fact in one merge", () => {
    const request = parseMergeRequest({
      memory_merge: {
        summary: "  5 facts   become 2. ",
        merges: [
          { text: "A and B.", replaces: ["workspace:a", "[workspace:b]", "workspace:a"], category: "suppliers" },
          { text: "B again.", replaces: ["workspace:b", "workspace:c"] },
          { text: "No ids.", replaces: ["workspace:../x", "made-up"] },
          { text: "", replaces: ["workspace:d", "workspace:e"] },
          { text: "D and E.", replaces: ["workspace:d", "workspace:e"], category: "mystery" },
        ],
      },
    });
    expect(request).toEqual({
      summary: "5 facts become 2.",
      merges: [
        { text: "A and B.", category: "suppliers", replaces: ["workspace:a", "workspace:b"] },
        { text: "D and E.", replaces: ["workspace:d", "workspace:e"] },
      ],
    });
  });

  it("is null when nothing usable is left", () => {
    expect(parseMergeRequest({ memory_merge: { merges: [{ text: "x", replaces: ["workspace:a"] }] } })).toBeNull();
    expect(parseMergeRequest({ memory_merge: {} })).toBeNull();
    expect(parseMergeRequest("merge")).toBeNull();
  });
});

describe("resolveMergeProposal", () => {
  it("shows each merge over the facts memory holds now, pinned if any is", async () => {
    memory.facts.set("workspace:a", fact("workspace:a", { pinned: true, category: "team" }));
    memory.facts.set("workspace:b", fact("workspace:b", { category: "team" }));
    const card = await resolveMergeProposal(tenant(), { memory_merge: { summary: "s", merges: [{ text: "A and B.", replaces: ["workspace:a", "workspace:b"] }] } }, "card1");
    expect(card).toEqual({
      kind: "memory-merge",
      id: "card1",
      summary: "s",
      merges: [
        {
          text: "A and B.",
          category: "team",
          scope: "workspace",
          pinned: true,
          originals: [
            { id: "workspace:a", content: "Fact workspace:a", pinned: true },
            { id: "workspace:b", content: "Fact workspace:b", pinned: false },
          ],
        },
      ],
    });
  });

  it("drops facts that are gone or not the member's to change, merges left with one, and mixed scopes", async () => {
    memory.facts.set("workspace:a", fact("workspace:a"));
    memory.facts.set("workspace:b", fact("workspace:b"));
    memory.facts.set("workspace:theirs", fact("workspace:theirs", { mine: false }));
    memory.facts.set("personal:p", fact("personal:p"));
    const raw = {
      memory_merge: {
        merges: [
          { text: "Theirs.", replaces: ["workspace:a", "workspace:theirs"] },
          { text: "Gone.", replaces: ["workspace:b", "workspace:gone"] },
          { text: "Mixed.", replaces: ["workspace:c", "personal:p"] },
        ],
      },
    };
    memory.facts.set("workspace:c", fact("workspace:c"));
    expect(await resolveMergeProposal(tenant(), raw)).toBeNull();
    // An owner may change any shared fact.
    const card = await resolveMergeProposal(tenant("owner"), raw);
    expect(card?.merges.map((m) => m.text)).toEqual(["Theirs."]);
  });
});

const proposal: MemoryMergeProposal = {
  kind: "memory-merge",
  id: "card",
  summary: "",
  merges: [
    { text: "A and B.", category: "team", scope: "workspace", pinned: false, originals: [{ id: "workspace:a", content: "A", pinned: false }, { id: "workspace:b", content: "B", pinned: false }] },
    { text: "C and D.", category: "team", scope: "workspace", pinned: false, originals: [{ id: "workspace:c", content: "C", pinned: false }, { id: "workspace:d", content: "D", pinned: false }] },
  ],
};
const original = (id: string) => ({ id, content: id, scope: "workspace" as const, category: "team" as const, pinned: false, createdBy: "me", savedAt: 1 });

describe("applyMerges", () => {
  it("merges the picked facts from the stored proposal with the member's edits, and skips merges whose facts changed", async () => {
    memory.mergeMemories.mockImplementation(async (_t, ids: string[], text: string) =>
      ids.includes("workspace:c") ? null : { memory: fact("workspace:new", { content: text }), originals: ids.map(original) },
    );
    const result = await applyMerges(tenant(), proposal, [1, 0, 0, 7], { "0": "  A, and B.  " });
    expect(memory.mergeMemories.mock.calls.map((c) => c.slice(1))).toEqual([
      [["workspace:a", "workspace:b"], "A, and B.", "team"],
      [["workspace:c", "workspace:d"], "C and D.", "team"],
    ]);
    expect(result).toEqual({
      merges: [{ index: 0, memoryId: "workspace:new", text: "A, and B.", originals: [original("workspace:a"), original("workspace:b")] }],
      skipped: 1,
    });
  });

  it("skips a merge the member may not make, and fails only when memory is down for all of them", async () => {
    memory.mergeMemories.mockRejectedValueOnce(Object.assign(new Error("no"), { status: 403 })).mockResolvedValueOnce(null);
    await expect(applyMerges(tenant(), proposal, [0, 1], {})).resolves.toEqual({ merges: [], skipped: 2 });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    memory.mergeMemories.mockRejectedValue(new Error("Supermemory down"));
    await expect(applyMerges(tenant(), proposal, [0], {})).rejects.toThrow("Supermemory down");
    error.mockRestore();
  });
});

describe("undoMerges", () => {
  it("undoes each merge whose merged fact is still there, and counts the rest as skipped", async () => {
    memory.unmergeMemories.mockImplementation(async (_t, id: string, originals: unknown[]) => (id === "workspace:m1" ? originals : null));
    const merged = {
      status: "merged" as const,
      at: 1,
      skipped: 0,
      merges: [
        { index: 0, memoryId: "workspace:m1", text: "A and B.", originals: [original("workspace:a"), original("workspace:b")] },
        { index: 1, memoryId: "workspace:m2", text: "C and D.", originals: [original("workspace:c"), original("workspace:d")] },
      ],
    };
    await expect(undoMerges(tenant(), merged)).resolves.toEqual({
      restored: 2,
      skipped: 1,
      merges: [
        { index: 0, text: "A and B." },
        { index: 1, text: "C and D." },
      ],
    });
    expect(memory.unmergeMemories).toHaveBeenCalledWith(expect.anything(), "workspace:m1", merged.merges[0].originals);
  });
});

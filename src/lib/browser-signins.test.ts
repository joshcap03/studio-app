import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/tenant-core";

vi.mock("@/lib/config", () => ({ getConfig: () => ({ browser: { apiKey: "bb_test_key" } }) }));

const { browserContextFor, forgetSignIns, hasSignIns, openContext, sealContext } = await import("./browser-signins");

const KEY = "bb_test_key";
const USER = "22222222-2222-4222-8222-222222222222";
const OTHER = "55555555-5555-4555-8555-555555555555";
const CONTEXT = "ctx_0123456789abcdef";

/** A person's account row, as RLS lets them read and write it: an update applies when awaited, if its filters match. */
function sessionWith(initial: string | null) {
  const row: { browser_context: string | null } = { browser_context: initial };
  const update = (change: { browser_context: string | null }) => {
    const checks: ((r: typeof row) => boolean)[] = [];
    const builder = {
      eq: (column: string, value: unknown) => (checks.push((r) => column === "user_id" || r[column as keyof typeof r] === value), builder),
      is: (column: string, value: null) => (checks.push((r) => r[column as keyof typeof r] === value), builder),
      then: (resolve: (v: { error: null }) => void) => {
        if (checks.every((check) => check(row))) row.browser_context = change.browser_context;
        resolve({ error: null });
      },
    };
    return builder;
  };
  const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { ...row }, error: null }) }) }), update }) };
  return { session: { userId: USER, db } as unknown as Session, row };
}

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("saved sign-ins, sealed", () => {
  it("open only for the person they were sealed for", () => {
    const sealed = sealContext(KEY, USER, CONTEXT);
    expect(openContext(KEY, USER, sealed)).toBe(CONTEXT);
    expect(openContext(KEY, OTHER, sealed)).toBeNull();
    expect(openContext("another_key", USER, sealed)).toBeNull();
    // Someone else's id, with this person's MAC, or none.
    expect(openContext(KEY, USER, `ctx_someone_elses.${sealed.split(".")[1]}`)).toBeNull();
    expect(openContext(KEY, USER, CONTEXT)).toBeNull();
    expect(openContext(KEY, USER, null)).toBeNull();
  });
});

describe("the person's saved sign-ins", () => {
  it("are made once, at Browserbase, and kept sealed on their account", async () => {
    const { session, row } = sessionWith(null);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: CONTEXT }), { status: 201 }));
    expect(await browserContextFor(session)).toBe(CONTEXT);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.browserbase.com/v1/contexts");
    expect(openContext(KEY, USER, row.browser_context)).toBe(CONTEXT);
    // Next time they're read, not made again.
    expect(await browserContextFor(session)).toBe(CONTEXT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keep the first when two runs make them at once", async () => {
    const { session, row } = sessionWith(null);
    const first = sealContext(KEY, USER, "ctx_first_one_made");
    fetchMock.mockImplementationOnce(async () => {
      row.browser_context = first; // The other run saved its own meanwhile.
      return new Response(JSON.stringify({ id: CONTEXT }), { status: 201 });
    });
    expect(await browserContextFor(session)).toBe("ctx_first_one_made");
    expect(row.browser_context).toBe(first);
  });

  it("replace an id the person wrote themselves", async () => {
    const forged = `ctx_someone_elses.${sealContext(KEY, OTHER, "ctx_someone_elses").split(".")[1]}`;
    const { session, row } = sessionWith(forged);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: CONTEXT }), { status: 201 }));
    expect(await browserContextFor(session)).toBe(CONTEXT);
    expect(openContext(KEY, USER, row.browser_context)).toBe(CONTEXT);
  });

  it("are forgotten at Browserbase and on the account", async () => {
    const { session, row } = sessionWith(sealContext(KEY, USER, CONTEXT));
    expect(await hasSignIns(session)).toBe(true);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await forgetSignIns(session);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.browserbase.com/v1/contexts/${CONTEXT}`);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
    expect(row.browser_context).toBeNull();
    expect(await hasSignIns(session)).toBe(false);
  });

  it("stay put when Browserbase can't forget them", async () => {
    const sealed = sealContext(KEY, USER, CONTEXT);
    const { session, row } = sessionWith(sealed);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(forgetSignIns(session)).rejects.toThrow();
    expect(row.browser_context).toBe(sealed);
  });
});

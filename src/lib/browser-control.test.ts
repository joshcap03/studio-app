import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tenant } from "@/lib/tenant-core";

vi.mock("@/lib/config", () => ({ getConfig: () => ({ browser: { apiKey: "bb_test_key" } }) }));

const { browserControl, sealSession } = await import("./browser-view");

const KEY = "bb_test_key";
const CONV = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";

/** A member whose conversation stores `browserSession`, reading only their own row. */
function tenantWith(browserSession: string | null): Tenant {
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { browser_session: browserSession }, error: null }) };
  return { userId: USER, workspace: { id: "ws" }, db: { from: () => query } } as unknown as Tenant;
}

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("taking over the conversation's browser", () => {
  it("gives a short-lived live view of the page the agent is on", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ status: "RUNNING", connectUrl: "wss://connect.browserbase.com/x?signingKey=secret" }))
      .mockResolvedValueOnce(
        json({
          debuggerFullscreenUrl: "https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=all",
          pages: [
            { debuggerFullscreenUrl: "https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=first" },
            { debuggerFullscreenUrl: "https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=last" },
          ],
        }),
      );
    const control = await browserControl(tenantWith(sealSession(KEY, CONV, USER, SESSION)), CONV);
    expect(control).toEqual({ ok: true, url: "https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=last" });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`https://api.browserbase.com/v1/sessions/${SESSION}/debug?expiresIn=600`);
    expect(init?.headers).toEqual({ "X-BB-API-Key": KEY });
  });

  it("refuses a browser that isn't this conversation's, or has closed", async () => {
    expect(await browserControl(tenantWith(null), CONV)).toEqual({ ok: false, reason: "none" });
    expect(await browserControl(tenantWith(`${SESSION}.forged`), CONV)).toEqual({ ok: false, reason: "none" });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json({ status: "COMPLETED" }));
    expect(await browserControl(tenantWith(sealSession(KEY, CONV, USER, SESSION)), CONV)).toEqual({ ok: false, reason: "ended" });
  });

  it("never passes on a link that isn't Browserbase's live view", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "RUNNING" })).mockResolvedValueOnce(json({ debuggerFullscreenUrl: "https://evil.example/browserbase.com/", pages: [] }));
    expect(await browserControl(tenantWith(sealSession(KEY, CONV, USER, SESSION)), CONV)).toEqual({ ok: false, reason: "failed" });
    fetchMock.mockResolvedValueOnce(json({ status: "RUNNING" })).mockResolvedValueOnce(json({ debuggerFullscreenUrl: "http://www.browserbase.com/x", pages: [] }));
    expect(await browserControl(tenantWith(sealSession(KEY, CONV, USER, SESSION)), CONV)).toEqual({ ok: false, reason: "failed" });
  });
});

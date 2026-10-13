import { beforeAll, describe, expect, it } from "vitest";

// Tenant isolation through the application's own HTTP API, as a browser would call it.
// Two independent accounts sign up through the app, each creates a workspace, then each
// tries to reach the other's data by changing ids in URLs, bodies, and cookies.
// Requires the QA server (`npm run qa:serve`, mock agent) on APP_URL.

const APP = process.env.APP_URL ?? "http://127.0.0.1:3100";

class Client {
  private cookies = new Map<string, string>();

  async request(path: string, init: RequestInit = {}, extraCookies: Record<string, string> = {}): Promise<Response> {
    const jar = new Map([...this.cookies, ...Object.entries(extraCookies)]);
    const res = await fetch(APP + path, {
      ...init,
      redirect: "manual",
      headers: {
        Origin: APP,
        "Content-Type": "application/json",
        Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...init.headers,
      },
    });
    for (const header of res.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === "" || /max-age=0/i.test(header)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  json(path: string, method: string, body?: unknown, extraCookies?: Record<string, string>) {
    return this.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body) }, extraCookies);
  }

  /** Sends a message and reads the whole NDJSON stream. */
  async send(conversationId: string, text: string, extraCookies?: Record<string, string>) {
    const res = await this.json(`/api/conversations/${conversationId}/messages`, "POST", { kind: "send", text }, extraCookies);
    const body = await res.text();
    return { res, body };
  }
}

async function signUp(label: string) {
  const client = new Client();
  const email = `${label}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const res = await client.json("/api/auth/signup", "POST", { email, password: `pw-${crypto.randomUUID()}` });
  expect(res.status, await res.clone().text()).toBe(200);
  return client;
}

let alice: Client;
let bob: Client;
let aliceWs: string;
let bobWs: string;
const aliceConv = crypto.randomUUID();
let aliceMemoryId: string;

beforeAll(async () => {
  const health = await fetch(`${APP}/login`).catch(() => null);
  if (!health) throw new Error(`QA server not reachable at ${APP}; run npm run qa:serve`);

  alice = await signUp("alice");
  bob = await signUp("bob");

  const a = await alice.json("/api/workspaces", "POST", { name: "Alice Atelier", businessContext: "rings" });
  expect(a.status).toBe(201);
  aliceWs = ((await a.json()) as { workspaceId: string }).workspaceId;
  const b = await bob.json("/api/workspaces", "POST", { name: "Bob Bakery" });
  bobWs = ((await b.json()) as { workspaceId: string }).workspaceId;

  const sent = await alice.send(aliceConv, "non-streaming alice-private-message");
  expect(sent.res.status).toBe(200);
  expect(sent.body).toContain('"type":"end"');

  const mem = await alice.json("/api/workspace/memories", "POST", { content: "alice-shared-memory" });
  aliceMemoryId = ((await mem.json()) as { memory: { id: string } }).memory.id;
}, 60_000);

describe("API tenant isolation", () => {
  it("serves each user only their own workspace and conversations", async () => {
    const ws = (await (await bob.json("/api/workspaces", "GET")).json()) as { workspaces: { id: string }[] };
    expect(ws.workspaces.map((w) => w.id)).toEqual([bobWs]);
    const list = (await (await bob.json("/api/conversations", "GET")).json()) as { conversations: unknown[] };
    expect(list.conversations).toEqual([]);
    const search = (await (await bob.json("/api/conversations?q=alice-private", "GET")).json()) as { conversations: unknown[] };
    expect(search.conversations).toEqual([]);
  });

  it("returns 404 for another tenant's conversation id on every verb", async () => {
    expect((await bob.json(`/api/conversations/${aliceConv}`, "GET")).status).toBe(404);
    expect((await bob.json(`/api/conversations/${aliceConv}`, "PATCH", { title: "pwned" })).status).toBe(404);
    expect((await bob.json(`/api/conversations/${aliceConv}`, "DELETE")).status).toBe(404);
    expect((await bob.json(`/api/conversations/${aliceConv}/stop`, "POST")).status).toBe(404);
    const retry = await bob.json(`/api/conversations/${aliceConv}/messages`, "POST", { kind: "retry" });
    expect(retry.status).toBe(404);
    const send = await bob.send(aliceConv, "inject into alice");
    expect(send.res.status).toBe(404);

    const still = (await (await alice.json(`/api/conversations/${aliceConv}`, "GET")).json()) as {
      conversation: { title: string };
      messages: { content: string }[];
    };
    expect(still.messages.map((m) => m.content)).not.toContain("inject into alice");
    expect(still.messages[0].content).toBe("non-streaming alice-private-message");
  });

  it("ignores a forged active-workspace cookie", async () => {
    const list = (await (await bob.json("/api/conversations", "GET", undefined, { lj_ws: aliceWs })).json()) as { conversations: unknown[] };
    expect(list.conversations).toEqual([]);
    const settings = (await (await bob.json("/api/workspace/settings", "GET", undefined, { lj_ws: aliceWs })).json()) as {
      settings: { name: string; businessContext: string };
    };
    expect(settings.settings.name).toBe("Bob Bakery");
    const memories = (await (await bob.json("/api/workspace/memories", "GET", undefined, { lj_ws: aliceWs })).json()) as {
      memories: { content: string }[];
    };
    expect(memories.memories.map((m) => m.content)).not.toContain("alice-shared-memory");
  });

  it("refuses to switch into a workspace the user doesn't belong to", async () => {
    expect((await bob.json("/api/workspaces/active", "POST", { workspaceId: aliceWs })).status).toBe(404);
  });

  it("refuses to delete or change another tenant's memory and settings", async () => {
    expect((await bob.json(`/api/workspace/memories/${aliceMemoryId}`, "DELETE")).status).toBe(404);
    await bob.json("/api/workspace/settings", "PATCH", { businessContext: "overwritten by bob" }, { lj_ws: aliceWs });
    const aliceSettings = (await (await alice.json("/api/workspace/settings", "GET")).json()) as { settings: { businessContext: string } };
    expect(aliceSettings.settings.businessContext).toBe("rings");
    const aliceMemories = (await (await alice.json("/api/workspace/memories", "GET")).json()) as { memories: { id: string }[] };
    expect(aliceMemories.memories.map((m) => m.id)).toContain(aliceMemoryId);
  });

  it("rejects unauthenticated and cross-origin requests", async () => {
    const anon = new Client();
    expect((await anon.json("/api/conversations", "GET")).status).toBe(401);
    expect((await anon.send(crypto.randomUUID(), "hi")).res.status).toBe(401);
    expect((await anon.request("/", { method: "GET" })).status).toBe(307);
    const forged = await bob.request(`/api/conversations/${crypto.randomUUID()}/messages`, {
      method: "POST",
      body: JSON.stringify({ kind: "send", text: "csrf" }),
      headers: { Origin: "https://evil.example" },
    });
    expect(forged.status).toBe(403);
  });

  it("sends a new member to onboarding until they have a workspace", async () => {
    const carol = await signUp("carol");
    expect((await carol.json("/api/conversations", "GET")).status).toBe(409);
    const page = await carol.request("/");
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toContain("/onboarding");
  });
});

describe("API limits", () => {
  it("caps concurrent runs per user", async () => {
    const dave = await signUp("dave");
    await dave.json("/api/workspaces", "POST", { name: "Dave Deli" });
    // Long mock runs: start two, then a third must be refused while they run.
    const first = dave.send(crypto.randomUUID(), "run a long reconciliation");
    const second = dave.send(crypto.randomUUID(), "run a long reconciliation");
    await new Promise((r) => setTimeout(r, 1500));
    const third = await dave.send(crypto.randomUUID(), "run a long reconciliation");
    expect(third.res.status).toBe(429);
    expect(third.body).toContain("tasks running");
    await Promise.all([first, second]);
  }, 60_000);

  it("caps runs per minute per user", async () => {
    const erin = await signUp("erin");
    await erin.json("/api/workspaces", "POST", { name: "Erin Eatery" });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await erin.send(crypto.randomUUID(), `non-streaming hello ${i}`)).res.status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  }, 90_000);
});

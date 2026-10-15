import { beforeAll, describe, expect, it } from "vitest";

// Approvals, attachments, edits, and memory suggestions through the app's own HTTP API, with
// the mock agent. Each test also tries the same request as another tenant.
// Requires the QA server (`npm run qa:serve`, mock agent) on APP_URL.

const APP = process.env.APP_URL ?? "http://127.0.0.1:3100";

class Client {
  private cookies = new Map<string, string>();

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(APP + path, {
      ...init,
      redirect: "manual",
      headers: {
        Origin: APP,
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
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

  json(path: string, method: string, body?: unknown) {
    return this.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  /** Runs a turn and returns its NDJSON events. */
  async turn(conversationId: string, body: unknown) {
    const res = await this.json(`/api/conversations/${conversationId}/messages`, "POST", body);
    const text = await res.text();
    const events = res.ok ? text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; [k: string]: unknown }) : [];
    return { res, text, events };
  }

  upload(name: string, content: string) {
    const form = new FormData();
    form.append("file", new File([content], name));
    return this.request("/api/attachments", { method: "POST", body: form });
  }
}

async function signUp(label: string) {
  const client = new Client();
  const email = `${label}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const res = await client.json("/api/auth/signup", "POST", { email, password: `pw-${crypto.randomUUID()}` });
  expect(res.status, await res.clone().text()).toBe(200);
  const ws = await client.json("/api/workspaces", "POST", { name: `${label} workspace` });
  expect(ws.status).toBe(201);
  return client;
}

let alice: Client;
let bob: Client;

beforeAll(async () => {
  const health = await fetch(`${APP}/login`).catch(() => null);
  if (!health) throw new Error(`QA server not reachable at ${APP}; run npm run qa:serve`);
  alice = await signUp("alice");
  bob = await signUp("bob");
});

describe("approvals over the API", () => {
  it("pauses, refuses new messages, lets only the owner decide, then continues", async () => {
    const conv = crypto.randomUUID();
    const first = await alice.turn(conv, { kind: "send", text: "non-streaming email Casting Co about the duplicate payment" });
    const approval = first.events.find((e) => e.type === "approval")?.approval as { id: string; status: string; summary: string };
    expect(approval).toMatchObject({ status: "pending", summary: expect.stringContaining("Casting Co") });
    expect(first.text).not.toContain("mock\":true"); // provider state stays on the server
    expect(first.events.at(-1)).toMatchObject({ type: "end", message: { status: "awaiting" } });

    const blocked = await alice.turn(conv, { kind: "send", text: "hello?" });
    expect(blocked.res.status).toBe(409);

    const stolen = await bob.turn(conv, { kind: "decide", approvalId: approval.id, decision: "approve" });
    expect(stolen.res.status).toBe(404);

    const decided = await alice.turn(conv, { kind: "decide", approvalId: approval.id, decision: "approve" });
    expect(decided.res.status).toBe(200);
    expect(decided.events.at(-1)).toMatchObject({ type: "end", message: { status: "complete", approvals: [{ status: "approved" }] } });

    const again = await alice.turn(conv, { kind: "decide", approvalId: approval.id, decision: "reject" });
    expect(again.res.status).toBe(409);

    const loaded = (await (await alice.json(`/api/conversations/${conv}`, "GET")).json()) as { messages: { approvals?: unknown[] }[] };
    expect(JSON.stringify(loaded)).not.toContain("provider");
    expect(loaded.messages[1].approvals).toHaveLength(1);
  });
});

describe("run limits over the API", () => {
  it("lets at most the concurrency limit through when many messages arrive at once", async () => {
    const carol = await signUp("carol");
    const statuses = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const { res } = await carol.turn(crypto.randomUUID(), { kind: "send", text: "hi" });
        return res.status;
      }),
    );
    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(2);
    expect(statuses.filter((s) => s !== 200).every((s) => s === 429)).toBe(true);
  });
});

describe("attachments over the API", () => {
  it("uploads, sends with a message, downloads only for the owner, and rejects unsupported files", async () => {
    const up = await alice.upload("orders.csv", "sku,qty\nA,3\n");
    expect(up.status).toBe(201);
    const { attachment } = (await up.json()) as { attachment: { id: string; mimeType: string } };
    expect(attachment.mimeType).toBe("text/csv");

    expect((await alice.upload("tool.exe", "MZ")).status).toBe(415);
    expect((await alice.upload("empty.csv", "")).status).toBe(400);

    // Bob can't send, read, or delete Alice's file.
    const bobConv = crypto.randomUUID();
    expect((await bob.turn(bobConv, { kind: "send", text: "mine now", attachmentIds: [attachment.id] })).res.status).toBe(400);
    expect((await bob.request(`/api/attachments/${attachment.id}`)).status).toBe(404);
    expect((await bob.json(`/api/attachments/${attachment.id}`, "DELETE")).status).toBe(404);

    const conv = crypto.randomUUID();
    const sent = await alice.turn(conv, { kind: "send", text: "non-streaming what's in this file?", attachmentIds: [attachment.id] });
    expect(sent.res.status).toBe(200);
    expect(sent.events[0]).toMatchObject({ type: "start", userMessage: { attachments: [{ id: attachment.id, name: "orders.csv" }] } });
    expect(sent.text).toContain("sku,qty"); // the mock read the first line

    const download = await alice.request(`/api/attachments/${attachment.id}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(await download.text()).toBe("sku,qty\nA,3\n");

    // Sent files can't be sent again or deleted on their own.
    expect((await alice.turn(conv, { kind: "send", text: "again", attachmentIds: [attachment.id] })).res.status).toBe(400);
    expect((await alice.json(`/api/attachments/${attachment.id}`, "DELETE")).status).toBe(404);

    // Deleting the conversation removes the file.
    expect((await alice.json(`/api/conversations/${conv}`, "DELETE")).status).toBe(204);
    expect((await alice.request(`/api/attachments/${attachment.id}`)).status).toBe(404);
  });
});

describe("edits and memory suggestions over the API", () => {
  it("edits only the caller's latest message", async () => {
    const conv = crypto.randomUUID();
    await alice.turn(conv, { kind: "send", text: "non-streaming help with operations" });
    const loaded = (await (await alice.json(`/api/conversations/${conv}`, "GET")).json()) as { messages: { id: string }[] };
    const userId = loaded.messages[0].id;
    expect((await bob.turn(conv, { kind: "edit", messageId: userId, text: "hijack" })).res.status).toBe(404);
    const edited = await alice.turn(conv, { kind: "edit", messageId: userId, text: "non-streaming analyze my inventory" });
    expect(edited.res.status).toBe(200);
    const after = (await (await alice.json(`/api/conversations/${conv}`, "GET")).json()) as { messages: { content: string }[] };
    expect(after.messages).toHaveLength(2);
    expect(after.messages[0].content).toBe("non-streaming analyze my inventory");
    expect(after.messages[1].content).toContain("629 variants");
  });

  it("remembers what the agent picks up right away, and only its owner can undo it", async (ctx) => {
    if ((await alice.json("/api/workspace/memories", "GET")).status === 503) ctx.skip(); // no SUPERMEMORY_API_KEY on the QA server
    const conv = crypto.randomUUID();
    const turn = await alice.turn(conv, { kind: "send", text: "non-streaming remember that Casting Co is net 30" });
    const events = turn.events.filter((e) => e.type === "memory-proposal");
    const proposal = events.at(-1)?.proposal as { id: string; content: string; status: string; memoryId: string };
    expect(proposal).toMatchObject({ status: "saved", memoryId: expect.stringMatching(/^workspace:/) });
    expect(proposal.content).toContain("net 30");
    const list = async (who: Client) =>
      ((await (await who.json("/api/workspace/memories", "GET")).json()) as { memories: { id: string; content: string }[] }).memories;
    expect((await list(alice)).map((m) => m.id)).toContain(proposal.memoryId);
    expect((await list(bob)).some((m) => m.content === proposal.content)).toBe(false);

    const decide = (who: Client, decision: string) => who.json(`/api/conversations/${conv}/proposals/${proposal.id}`, "POST", { decision });
    expect((await decide(bob, "undo")).status).toBe(404);
    expect((await bob.json(`/api/workspace/memories/${encodeURIComponent(proposal.memoryId)}`, "DELETE")).status).toBe(404);
    expect((await decide(alice, "undo")).status).toBe(200);
    expect((await decide(alice, "undo")).status).toBe(409);
    expect((await list(alice)).map((m) => m.id)).not.toContain(proposal.memoryId);

    // Changed their mind: save it again, then clean up.
    const again = await decide(alice, "save");
    expect(again.status).toBe(200);
    const { proposal: resaved } = (await again.json()) as { proposal: { memoryId: string } };
    expect((await alice.json(`/api/workspace/memories/${encodeURIComponent(resaved.memoryId)}`, "DELETE")).status).toBe(204);
  });

});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serviceClient } from "./helpers";

// The secure card for a login or card (request_secret), through the app's HTTP API with the mock
// agent: it reaches only pages that know it, only its member can use it, and what's typed on it
// never lands anywhere, even when the fill is refused (the QA server has no Browserbase key, so
// there's no browser to fill). Requires the QA server and the local Supabase stack.

const APP = process.env.APP_URL ?? "http://127.0.0.1:3100";
const PASSWORD = "pw-local-secrets-api-only";
const SECRET = `leak-check-${crypto.randomUUID()}`;

class Client {
  private cookies = new Map<string, string>();

  async json(path: string, method: string, body?: unknown): Promise<Response> {
    const res = await fetch(APP + path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      headers: { Origin: APP, "Content-Type": "application/json", Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    for (const header of res.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const index = pair.indexOf("=");
      const value = pair.slice(index + 1);
      if (value === "" || /max-age=0/i.test(header)) this.cookies.delete(pair.slice(0, index));
      else this.cookies.set(pair.slice(0, index), value);
    }
    return res;
  }

  /** Runs a turn; the reply as its end event carried it. */
  async turn(conversationId: string, body: unknown): Promise<{ id: string; ui?: { id: string; kind: string }[] }> {
    const res = await this.json(`/api/conversations/${conversationId}/messages`, "POST", body);
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const end = text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; message?: { id: string; ui?: { id: string; kind: string }[] } })
      .find((e) => e.type === "end");
    expect(end?.message).toBeTruthy();
    return end!.message!;
  }
}

async function member(email: string): Promise<Client> {
  const api = new Client();
  if ((await api.json("/api/auth/signin", "POST", { email, password: PASSWORD })).status !== 200) {
    const res = await api.json("/api/auth/signup", "POST", { email, password: PASSWORD });
    expect(res.status, await res.clone().text()).toBe(200);
  }
  const listed = (await (await api.json("/api/workspaces", "GET")).json()) as { active: string | null };
  if (!listed.active) expect((await api.json("/api/workspaces", "POST", { name: `${email.split("@")[0]} agent` })).status).toBe(201);
  return api;
}

let alice: Client;
let bob: Client;
const made: string[] = [];

beforeAll(async () => {
  alice = await member("secrets-api-alice@example.test");
  bob = await member("secrets-api-bob@example.test");
});

afterAll(async () => {
  for (const id of made) await alice.json(`/api/conversations/${id}`, "DELETE");
});

describe("the secure card for a login", () => {
  it("goes only to pages that know it", async () => {
    const conversation = crypto.randomUUID();
    made.push(conversation);
    const older = await alice.turn(conversation, { kind: "send", text: "Sign me in", offers: true });
    expect(older.ui ?? []).toEqual([]);
    const newer = await alice.turn(conversation, { kind: "send", text: "Sign me in", offers: true, secrets: true });
    expect(newer.ui).toEqual([expect.objectContaining({ kind: "secret", secret: "login" })]);
    const plain = (await (await alice.json(`/api/conversations/${conversation}?offers=1`, "GET")).json()) as { messages: { id: string; ui?: unknown[] }[] };
    expect(plain.messages.find((m) => m.id === newer.id)?.ui).toEqual([]);
  });

  it("is used only by its member, and what's typed on it is never kept", async () => {
    const conversation = crypto.randomUUID();
    made.push(conversation);
    const reply = await alice.turn(conversation, { kind: "send", text: "Sign me in", offers: true, secrets: true });
    const block = reply.ui!.find((b) => b.kind === "secret")!;
    const path = `/api/conversations/${conversation}/secrets/${block.id}`;

    // Someone else can't see or use it.
    expect((await bob.json(path, "GET")).status).toBe(404);
    expect((await bob.json(path, "POST", { use: "login", username: "bob", password: SECRET, save: true })).status).toBe(404);

    // With no browser to fill, nothing is filled, saved, or answered.
    const lookup = (await (await alice.json(path, "GET")).json()) as { site: string | null; browser: string };
    expect(lookup).toMatchObject({ site: null, browser: "off" });
    const refused = await alice.json(path, "POST", { use: "login", username: "alice@example.test", password: SECRET, save: true });
    expect(refused.status).toBe(404);
    expect(await refused.text()).not.toContain(SECRET);
    // A card number that isn't one is refused before anything else.
    expect((await alice.json(path, "POST", { use: "card", number: "1234", name: "A", expiry: "04/27", cvv: "123", save: false })).status).toBe(400);

    const admin = await serviceClient();
    const messages = await admin.from("messages").select("content, ui, ui_response").eq("conversation_id", conversation);
    expect(JSON.stringify(messages.data)).not.toContain(SECRET);
    const saved = await admin.from("credentials").select("id, label, username").eq("username", "alice@example.test");
    expect(saved.data).toEqual([]);
  });
});

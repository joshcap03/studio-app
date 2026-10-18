import { beforeAll, describe, expect, it } from "vitest";

// Voice calls through the app's HTTP API, with the mock voice (`npm run qa:serve` sets
// VOICE_PROVIDER=mock and allowlists these accounts for the voice preview): a call belongs to
// the member who started it, only they can end it, and the voice front only answers for the
// call its sealed context was made for, from that member's own session. Requires the QA server.

const APP = process.env.APP_URL ?? "http://127.0.0.1:3100";
const PASSWORD = "pw-local-voice-api-only";
const FRONT = "/api/voice/llm/v1/chat/completions";
const MARKER = "⟦studio⟧";

class Client {
  private cookies = new Map<string, string>();

  async json(path: string, method: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const res = await fetch(APP + path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      headers: { Origin: APP, "Content-Type": "application/json", Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "), ...headers },
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

interface Grant {
  sessionId: string;
  provider: string;
  conversationId: string;
  context: string;
  persona: { name: string };
  maxSeconds: number;
  join: { kind: string };
}

async function start(api: Client): Promise<Grant> {
  const res = await api.json("/api/voice/session", "POST", {});
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { grant: Grant }).grant;
}

/** The voice front's reply, as text and tool names. */
async function front(api: Client, grant: Grant, messages: unknown[], headers: Record<string, string> = {}) {
  const res = await api.json(FRONT, "POST", { messages, stream: true }, { "X-Studio-Conversation": grant.conversationId, "X-Studio-Voice-Ctx": grant.context, ...headers });
  if (res.status !== 200) return { status: res.status, text: "", tools: [] as string[] };
  let text = "";
  const tools: string[] = [];
  for (const event of (await res.text()).split("\n\n")) {
    const data = event.replace(/^data:\s*/, "").trim();
    if (!data || data === "[DONE]") continue;
    const delta = JSON.parse(data).choices[0].delta as { content?: string; tool_calls?: { function: { name: string } }[] };
    text += delta.content ?? "";
    for (const t of delta.tool_calls ?? []) tools.push(t.function.name);
  }
  return { status: 200, text, tools };
}

let alice: Client;
let bob: Client;

beforeAll(async () => {
  const health = await fetch(`${APP}/login`).catch(() => null);
  if (!health) throw new Error(`QA server not reachable at ${APP}; run npm run qa:serve`);
  alice = await member("voice-api-alice@example.test");
  bob = await member("voice-api-bob@example.test");
});

describe("voice calls over the API", () => {
  it("start for allowlisted members with a sealed, labeled mock call", async () => {
    const grant = await start(alice);
    expect(grant.provider).toBe("mock");
    expect(grant.join.kind).toBe("mock");
    expect(grant.maxSeconds).toBeGreaterThan(0);
    expect(grant.context.split(".")).toHaveLength(2);
    expect((await alice.json(`/api/voice/session/${grant.sessionId}/end`, "POST", {})).status).toBe(200);
  });

  it("refuse members outside the preview", async () => {
    const outsider = await member(`voice-outsider-${crypto.randomUUID().slice(0, 8)}@example.test`);
    expect((await outsider.json("/api/voice/session", "POST", {})).status).toBe(404);
  });

  it("are ended only by the member who started them", async () => {
    const grant = await start(alice);
    expect((await bob.json(`/api/voice/session/${grant.sessionId}/end`, "POST", {})).status).toBe(404);
    expect((await alice.json(`/api/voice/session/${grant.sessionId}/end`, "POST", {})).status).toBe(200);
    expect((await alice.json(`/api/voice/session/${grant.sessionId}/end`, "POST", {})).status).toBe(404);
  });

  it("answer the voice front only for the call's own member, conversation, and seal", async () => {
    const grant = await start(alice);
    const greeting = await front(alice, grant, [{ role: "user", content: `${MARKER}${JSON.stringify({ cue: "hello" })}` }]);
    expect(greeting).toMatchObject({ status: 200, text: `Hey! I'm ${grant.persona.name}.` });

    // Bob's session with Alice's sealed context.
    expect((await front(bob, grant, [])).status).toBe(401);
    // Alice's context replayed into another conversation.
    expect((await front(alice, grant, [], { "X-Studio-Conversation": "mock_other" })).status).toBe(401);
    // An edited context.
    const [payload, mac] = grant.context.split(".");
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), guardrail: null, uid: "x" })).toString("base64url");
    expect((await front(alice, grant, [], { "X-Studio-Voice-Ctx": `${edited}.${mac}` })).status).toBe(401);
    // A provider key doesn't stand in for the mock's session.
    const anonymous = new Client();
    expect((await front(anonymous, grant, [], { Authorization: "Bearer not-the-key" })).status).toBe(401);
    await alice.json(`/api/voice/session/${grant.sessionId}/end`, "POST", {});
  });

  it("hands the member's words to the browser's tools, and says Studio's lines word for word", async () => {
    const grant = await start(alice);
    const said = await front(alice, grant, [{ role: "user", content: "Honestly I'm drowning in invoices" }]);
    expect(said.tools).toEqual(["send_message"]);
    const relayed = await front(alice, grant, [{ role: "user", content: `${MARKER}${JSON.stringify({ say: ["Reading your résumé…"] })}` }]);
    expect(relayed.text).toBe("Reading your résumé…");
    await alice.json(`/api/voice/session/${grant.sessionId}/end`, "POST", {});
  });
});

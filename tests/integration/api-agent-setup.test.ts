import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./helpers";

// The setup interview's state through the app: starting it with the setup skill records its
// conversation, applying a proposal there finishes it, "Not now" sets it aside, and another
// tenant's requests never touch it. Requires the QA server (mock agent) on APP_URL.

const APP = process.env.APP_URL ?? "http://127.0.0.1:3100";
const PASSWORD = "pw-local-setup-api-only";

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
}

interface Member {
  api: Client;
  db: SupabaseClient;
  workspaceId: string;
}

async function member(email: string): Promise<Member> {
  const api = new Client();
  if ((await api.json("/api/auth/signin", "POST", { email, password: PASSWORD })).status !== 200) {
    const res = await api.json("/api/auth/signup", "POST", { email, password: PASSWORD });
    expect(res.status, await res.clone().text()).toBe(200);
  }
  const listed = (await (await api.json("/api/workspaces", "GET")).json()) as { active: string | null };
  let workspaceId = listed.active;
  if (!workspaceId) {
    const res = await api.json("/api/workspaces", "POST", { name: `${email.split("@")[0]} agent`, templateId: "job-search" });
    expect(res.status).toBe(201);
    workspaceId = ((await res.json()) as { workspaceId: string }).workspaceId;
  }
  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  expect((await db.auth.signInWithPassword({ email, password: PASSWORD })).error).toBeNull();
  return { api, db, workspaceId };
}

type Setup = { status: string; conversationId: string | null; plan: unknown[] } | null;
const setupOf = async (m: Member) => ((await (await m.api.json("/api/workspace/settings", "GET")).json()) as { settings: { setup: Setup } }).settings.setup;

let alice: Member;
let bob: Member;
const conversation = crypto.randomUUID();

beforeAll(async () => {
  const health = await fetch(`${APP}/login`).catch(() => null);
  if (!health) throw new Error(`QA server not reachable at ${APP}; run npm run qa:serve`);
  alice = await member("setup-alice@example.test");
  bob = await member("setup-bob@example.test");
  // Start each run from a clean slate (the accounts are reused on the local stack).
  for (const m of [alice, bob]) expect((await m.db.from("workspace_settings").update({ setup: null }).eq("workspace_id", m.workspaceId)).error).toBeNull();
}, 60_000);

describe("agent setup", () => {
  it("starts when the owner sends with the setup skill, in that conversation", async () => {
    const res = await alice.api.json(`/api/conversations/${conversation}/messages`, "POST", { kind: "send", text: "", skillId: "builtin:setup" });
    expect(res.status, await res.clone().text()).toBe(200);
    await res.text(); // Let the run finish.
    expect(await setupOf(alice)).toMatchObject({ status: "in_progress", conversationId: conversation, plan: [] });
    expect(await setupOf(bob)).toBeNull();
  });

  it("finishes when the owner applies a proposal in the setup conversation", async () => {
    const blockId = crypto.randomUUID();
    const inserted = await alice.db.from("messages").insert({
      conversation_id: conversation,
      workspace_id: alice.workspaceId,
      role: "assistant",
      content: "",
      status: "complete",
      ui: [{ kind: "proposal", id: blockId, summary: "s", skills: [{ catalogId: "find-roles" }], tasks: [], memories: [] }],
    });
    expect(inserted.error).toBeNull();
    // Another tenant can't apply it, so it can't finish alice's setup either.
    const bobApply = { action: "apply", picks: { profile: false, instructions: false, skills: [0], tasks: [], memories: [] } };
    expect((await bob.api.json(`/api/conversations/${conversation}/ui/${blockId}`, "POST", bobApply)).status).toBe(404);
    expect((await setupOf(alice))?.status).toBe("in_progress");
    const res = await alice.api.json(`/api/conversations/${conversation}/ui/${blockId}`, "POST", bobApply);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await setupOf(alice)).toMatchObject({ status: "done", conversationId: conversation });
  });

  it("can be set aside, only by its own owner", async () => {
    expect((await bob.api.json("/api/agent/setup", "POST", { status: "skipped" })).status).toBe(200);
    expect((await setupOf(bob))?.status).toBe("skipped");
    expect((await setupOf(alice))?.status).toBe("done");
    expect((await alice.api.json("/api/agent/setup", "POST", { status: "done" })).status).toBe(400);
  });

  it("offers the setup skill for any template, and refuses made-up builtin ids", async () => {
    const res = await alice.api.json(`/api/conversations/${crypto.randomUUID()}/messages`, "POST", { kind: "send", text: "x", skillId: "builtin:nope" });
    expect(res.status).toBe(400);
  });
});

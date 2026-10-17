import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./helpers";

// Forms and proposals under a reply, through the app's HTTP API: only the member the card was
// shown to can answer it, an answer is saved once, and Apply changes exactly the stored
// proposal's picked items (plus the member's own text edits), never items from the request.
// Uses the allowlisted task accounts so applied tasks are real. Requires the QA server on APP_URL.

const APP = process.env.APP_URL ?? "http://127.0.0.1:3100";
const PASSWORD = "pw-local-tasks-api-only";

class Client {
  private cookies = new Map<string, string>();

  /** Uploads a small text file to attach, returning its id. */
  async upload(name: string, text: string): Promise<string> {
    const body = new FormData();
    body.set("file", new File([text], name, { type: "text/plain" }));
    const res = await fetch(`${APP}/api/attachments`, {
      method: "POST",
      body,
      headers: { Origin: APP, Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { attachment: { id: string } }).attachment.id;
  }

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
    const res = await api.json("/api/workspaces", "POST", { name: `${email.split("@")[0]} space` });
    expect(res.status).toBe(201);
    workspaceId = ((await res.json()) as { workspaceId: string }).workspaceId;
  }
  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  expect((await db.auth.signInWithPassword({ email, password: PASSWORD })).error).toBeNull();
  return { api, db, workspaceId };
}

const tag = crypto.randomUUID().slice(0, 8);
const conversation = crypto.randomUUID();
const formId = crypto.randomUUID();
const proposalId = crypto.randomUUID();
let alice: Member;
let bob: Member;
let originalInstructions = "";

const form = { kind: "form", id: formId, title: "Your search", fields: [{ kind: "text", id: "roles", label: "Roles", required: true }], submitLabel: "Send" };
const keepFormId = crypto.randomUUID();
const keepForm = {
  kind: "form",
  id: keepFormId,
  title: "Your résumé",
  fields: [{ kind: "file", id: "resume", label: "Résumé", required: true, accept: ["txt"], max: 1, keep: true }],
  submitLabel: "Send",
};
const proposal = {
  kind: "proposal",
  id: proposalId,
  summary: "What I'll do.",
  profile: `ui-cards-profile-${tag}`,
  instructions: `ui-cards-instructions-${tag}`,
  skills: [],
  tasks: [
    { title: `UI cards ${tag} kept`, instructions: "Look.", schedule: { every: "weekdays", at: "08:00" } },
    { title: `UI cards ${tag} skipped`, instructions: "Don't.", schedule: null },
  ],
  memories: [],
};

beforeAll(async () => {
  const health = await fetch(`${APP}/login`).catch(() => null);
  if (!health) throw new Error(`QA server not reachable at ${APP}; run npm run qa:serve`);
  alice = await member("tasks-api-alice@example.test");
  bob = await member("tasks-api-bob@example.test");
  originalInstructions = ((await (await alice.api.json("/api/workspace/settings", "GET")).json()) as { settings: { agentInstructions: string } }).settings.agentInstructions;
  expect((await alice.db.from("conversations").insert({ id: conversation, workspace_id: alice.workspaceId, title: "Setup" })).error).toBeNull();
  const inserted = await alice.db.from("messages").insert({
    conversation_id: conversation,
    workspace_id: alice.workspaceId,
    role: "assistant",
    content: "",
    status: "complete",
    ui: [form, proposal, keepForm],
  });
  expect(inserted.error).toBeNull();
}, 60_000);

afterAll(async () => {
  await alice?.api.json("/api/workspace/settings", "PATCH", { agentInstructions: originalInstructions });
  const left = (await (await alice?.api.json("/api/tasks", "GET"))?.json()) as { tasks?: { id: string; title: string }[] } | undefined;
  for (const t of left?.tasks ?? []) if (t.title.includes(tag)) await alice.api.json(`/api/tasks/${t.id}`, "DELETE");
  await alice?.db.from("conversations").delete().eq("id", conversation);
});

const url = (blockId: string) => `/api/conversations/${conversation}/ui/${blockId}`;
const picks = { profile: false, instructions: true, skills: [], tasks: [0], memories: [] };

describe("ui card answers", () => {
  it("are refused for anyone the card wasn't shown to", async () => {
    expect((await bob.api.json(url(formId), "POST", { action: "submit" })).status).toBe(404);
    expect((await bob.api.json(url(proposalId), "POST", { action: "apply", picks })).status).toBe(404);
    expect((await alice.api.json(url(crypto.randomUUID()), "POST", { action: "submit" })).status).toBe(404);
  });

  it("keep a form answered, once", async () => {
    expect((await alice.api.json(url(proposalId), "POST", { action: "submit" })).status).toBe(400);
    const sent = await alice.api.json(url(formId), "POST", { action: "submit" });
    expect(sent.status, await sent.clone().text()).toBe(200);
    expect((await alice.api.json(url(formId), "POST", { action: "submit" })).status).toBe(409);
  });

  it("apply only the picked items of the stored proposal, with the member's edits, once", async () => {
    const edited = `ui-cards-edited-${tag}`;
    const res = await alice.api.json(url(proposalId), "POST", { action: "apply", picks, edits: { instructions: edited }, timezone: "America/New_York" });
    expect(res.status, await res.clone().text()).toBe(200);
    const { response } = (await res.json()) as { response: { applied: unknown; picks: unknown; taskIds?: string[] } };
    expect(response.applied).toEqual({ settings: true, skills: 0, tasks: 1, memories: 0, skipped: 0 });
    // Only what took effect: the memory picks are empty when memory isn't set up locally.
    expect(response.picks).toEqual({ profile: false, instructions: true, skills: [], tasks: [0], memories: [] });

    const settings = ((await (await alice.api.json("/api/workspace/settings", "GET")).json()) as { settings: { profile: string; agentInstructions: string } }).settings;
    expect(settings.agentInstructions).toBe(edited);
    expect(settings.profile).not.toBe(proposal.profile);
    const tasks = ((await (await alice.api.json("/api/tasks", "GET")).json()) as { tasks: { id: string; title: string; status: string }[] }).tasks.filter((t) => t.title.includes(tag));
    expect(tasks).toEqual([expect.objectContaining({ title: `UI cards ${tag} kept`, status: "active" })]);
    // The applied task's id comes back, so "Do the first one now" can run it.
    expect(response.taskIds).toEqual([tasks[0].id]);

    expect((await alice.api.json(url(proposalId), "POST", { action: "apply", picks })).status).toBe(409);
    const stored = await alice.db.from("messages").select("ui_response").eq("conversation_id", conversation).single();
    expect(stored.data?.ui_response).toMatchObject({ [formId]: { status: "submitted" }, [proposalId]: { status: "applied" } });
  });

  it("move a keep field's uploads onto the agent's files, and only the member's own", async () => {
    const mine = await alice.api.upload(`resume-${tag}.txt`, "Alice's résumé (test).");
    const theirs = await bob.api.upload(`resume-${tag}.txt`, "Bob's (test).");
    // A form without a keep field keeps nothing (this one was already sent, but the check comes first).
    expect((await alice.api.json(url(formId), "POST", { action: "submit", keepFiles: [mine] })).status).toBe(400);
    expect((await alice.api.json(url(keepFormId), "POST", { action: "submit", keepFiles: [theirs] })).status).toBe(404);
    const sent = await alice.api.json(url(keepFormId), "POST", { action: "submit", keepFiles: [mine] });
    expect(sent.status, await sent.clone().text()).toBe(200);
    const files = ((await (await alice.api.json("/api/agent/files", "GET")).json()) as { files: { id: string }[] }).files;
    expect(files.map((f) => f.id)).toContain(mine);
    await alice.api.json(`/api/agent/files/${mine}`, "DELETE");
    await bob.db.from("attachments").delete().eq("id", theirs);
  });

  it("reject picks that aren't indexes", async () => {
    const res = await alice.api.json(url(proposalId), "POST", { action: "apply", picks: { ...picks, tasks: [{ title: "forged" }] } });
    expect(res.status).toBe(400);
  });
});

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
const verdictFormId = crypto.randomUUID();
const verdictForm = {
  kind: "form",
  id: verdictFormId,
  title: "Trial run",
  fields: [
    {
      kind: "verdict",
      id: "roles",
      label: "Would you go for these?",
      required: true,
      reasons: ["Too junior"],
      items: [
        { id: "acme", title: `Acme ${tag}` },
        { id: "globex", title: `Globex ${tag}` },
      ],
    },
  ],
  submitLabel: "Send",
};
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
    ui: [form, proposal, keepForm, verdictForm],
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
  it("save the member's keep/pass calls against the card's own items, and count them", async () => {
    const verdicts = [
      { fieldId: "roles", itemId: "acme", verdict: "keep" },
      { fieldId: "roles", itemId: "globex", verdict: "pass", reason: " Too junior " },
      // Not in the card: dropped, never stored under a title the request made up.
      { fieldId: "roles", itemId: "forged", verdict: "keep" },
      { fieldId: "nope", itemId: "acme", verdict: "pass" },
    ];
    const res = await alice.api.json(url(verdictFormId), "POST", { action: "submit", verdicts });
    expect(res.status, await res.clone().text()).toBe(200);
    const stored = await alice.db.from("agent_verdicts").select("item_id, title, verdict, reason").eq("block_id", verdictFormId).order("item_id");
    expect(stored.data).toEqual([
      { item_id: "acme", title: `Acme ${tag}`, verdict: "keep", reason: null },
      { item_id: "globex", title: `Globex ${tag}`, verdict: "pass", reason: "Too junior" },
    ]);
    expect((await bob.db.from("agent_verdicts").select("id").eq("block_id", verdictFormId)).data).toEqual([]);
    expect((await alice.api.json(url(verdictFormId), "POST", { action: "submit", verdicts: [{ fieldId: "roles", itemId: "acme", verdict: "maybe" }] })).status).toBe(400);
  });

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

// Merging facts the agent proposed (merge_memories). With memory set up on the QA server this
// runs the whole merge and Undo; without it, only the refusals.
describe("merging remembered facts", () => {
  const mergeId = crypto.randomUUID();
  type Fact = { id: string; content: string; pinned: boolean; scope: string };
  const listFacts = async () => ((await (await alice.api.json("/api/workspace/memories", "GET")).json()) as { memories: Fact[] }).memories;
  let memoryOn = false;
  let facts: Fact[] = [];

  beforeAll(async () => {
    const add = async (content: string, scope = "workspace") => {
      const res = await alice.api.json("/api/workspace/memories", "POST", { content, scope, category: "team" });
      if (res.status === 503) return null;
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { memory: Fact }).memory;
    };
    const first = await add(`Merge ${tag}: Ana leads design.`);
    memoryOn = Boolean(first);
    if (first) {
      const second = (await add(`Merge ${tag}: Ana also runs hiring.`))!;
      const pinned = await alice.api.json(`/api/workspace/memories/${encodeURIComponent(second.id)}`, "PATCH", { pinned: true });
      expect(pinned.status, await pinned.clone().text()).toBe(200);
      facts = [first, ((await pinned.json()) as { memory: Fact }).memory];
    } else {
      facts = [
        { id: "workspace:a", content: "A", pinned: false, scope: "workspace" },
        { id: "workspace:b", content: "B", pinned: false, scope: "workspace" },
      ];
    }
    const card = {
      kind: "memory-merge",
      id: mergeId,
      summary: "2 facts become 1.",
      merges: [{ text: `Merge ${tag}: Ana leads design and hiring.`, category: "team", scope: "workspace", pinned: true, originals: facts.map(({ id, content, pinned }) => ({ id, content, pinned })) }],
    };
    const inserted = await alice.db.from("messages").insert({ conversation_id: conversation, workspace_id: alice.workspaceId, role: "assistant", content: "", status: "complete", ui: [card] });
    expect(inserted.error).toBeNull();
  }, 60_000);

  afterAll(async () => {
    if (!memoryOn) return;
    for (const m of await listFacts()) if (m.content.includes(tag)) await alice.api.json(`/api/workspace/memories/${encodeURIComponent(m.id)}`, "DELETE");
  });

  it("are refused for anyone the card wasn't shown to, for other cards, and before anything was merged", async () => {
    expect((await bob.api.json(url(mergeId), "POST", { action: "merge", picks: [0] })).status).toBe(404);
    expect((await alice.api.json(url(proposalId), "POST", { action: "merge", picks: [0] })).status).toBe(400);
    expect((await alice.api.json(url(mergeId), "POST", { action: "apply", picks })).status).toBe(400);
    expect((await alice.api.json(url(mergeId), "POST", { action: "undo" })).status).toBe(409);
    expect((await alice.api.json(url(mergeId), "POST", { action: "merge", picks: [] })).status).toBe(400);
  });

  it("merge the stored facts into one that stays pinned, once, and Undo brings the originals back", async () => {
    if (!memoryOn) {
      expect((await alice.api.json(url(mergeId), "POST", { action: "merge", picks: [0] })).status).toBe(503);
      return;
    }
    const edited = `Merge ${tag}: Ana leads design and runs hiring.`;
    const res = await alice.api.json(url(mergeId), "POST", { action: "merge", picks: [0], edits: { "0": edited } });
    expect(res.status, await res.clone().text()).toBe(200);
    const { response } = (await res.json()) as { response: { status: string; skipped: number; merges: { memoryId: string; text: string }[] } };
    expect(response).toMatchObject({ status: "merged", skipped: 0, merges: [{ text: edited }] });
    let mine = (await listFacts()).filter((m) => m.content.includes(tag));
    expect(mine).toEqual([expect.objectContaining({ id: response.merges[0].memoryId, content: edited, pinned: true, scope: "workspace" })]);
    expect((await alice.api.json(url(mergeId), "POST", { action: "merge", picks: [0] })).status).toBe(409);
    expect((await bob.api.json(url(mergeId), "POST", { action: "undo" })).status).toBe(404);

    const undo = await alice.api.json(url(mergeId), "POST", { action: "undo" });
    expect(undo.status, await undo.clone().text()).toBe(200);
    expect(((await undo.json()) as { response: unknown }).response).toMatchObject({ status: "undone", restored: 2, skipped: 0 });
    mine = (await listFacts()).filter((m) => m.content.includes(tag));
    expect(mine.map((m) => [m.content, m.pinned]).sort()).toEqual(facts.map((f) => [f.content, f.pinned]).sort());
    expect((await alice.api.json(url(mergeId), "POST", { action: "undo" })).status).toBe(409);
  });
});

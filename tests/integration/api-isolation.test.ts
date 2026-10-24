import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
        // A multipart body sets its own type (with the boundary).
        ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
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

  upload(path: string, name: string, content: string, extraCookies?: Record<string, string>) {
    const form = new FormData();
    form.append("file", new File([content], name, { type: "text/plain" }));
    return this.request(path, { method: "POST", body: form }, extraCookies);
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
let aliceMemoryId: string | undefined;

beforeAll(async () => {
  const health = await fetch(`${APP}/login`).catch(() => null);
  if (!health) throw new Error(`QA server not reachable at ${APP}; run npm run qa:serve`);

  alice = await signUp("alice");
  bob = await signUp("bob");

  const a = await alice.json("/api/workspaces", "POST", { name: "Alice Atelier", profile: "rings" });
  expect(a.status).toBe(201);
  aliceWs = ((await a.json()) as { workspaceId: string }).workspaceId;
  const b = await bob.json("/api/workspaces", "POST", { name: "Bob Bakery" });
  bobWs = ((await b.json()) as { workspaceId: string }).workspaceId;

  const sent = await alice.send(aliceConv, "non-streaming alice-private-message");
  expect(sent.res.status).toBe(200);
  expect(sent.body).toContain('"type":"end"');

  // Memory needs Supermemory on the QA server (SUPERMEMORY_API_KEY); without it, skip those checks.
  const mem = await alice.json("/api/workspace/memories", "POST", { content: "alice-shared-memory" });
  if (mem.status !== 503) {
    expect(mem.status).toBe(201);
    aliceMemoryId = ((await mem.json()) as { memory: { id: string } }).memory.id;
  }
}, 60_000);

afterAll(async () => {
  if (aliceMemoryId) await alice.json(`/api/workspace/memories/${encodeURIComponent(aliceMemoryId)}`, "DELETE");
});

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

  it("keeps agent files to the member who added them, and sends them with every run", async () => {
    const added = await alice.upload("/api/agent/files", "resume.txt", "alice-resume-first-line\nmore");
    expect(added.status, await added.clone().text()).toBe(201);
    const file = ((await added.json()) as { file: { id: string; name: string } }).file;
    expect(file.name).toBe("resume.txt");
    const mine = (await (await alice.request("/api/agent/files")).json()) as { files: { id: string }[] };
    expect(mine.files.map((f) => f.id)).toEqual([file.id]);

    // A new chat with the agent gets the file without attaching it.
    const run = await alice.send(crypto.randomUUID(), "non-streaming what's on my resume?");
    expect(run.res.status).toBe(200);
    expect(run.body).toContain("alice-resume-first-line");

    // Bob can't see, remove, or receive it, even naming Alice's agent in the cookie.
    for (const cookies of [{}, { lj_ws: aliceWs }] as Record<string, string>[]) {
      const theirs = (await (await bob.request("/api/agent/files", {}, cookies)).json()) as { files: unknown[] };
      expect(theirs.files).toEqual([]);
      expect((await bob.json(`/api/agent/files/${file.id}`, "DELETE", undefined, cookies)).status).toBe(404);
    }
    const bobRun = await bob.send(crypto.randomUUID(), "non-streaming what's on my resume?", { lj_ws: aliceWs });
    expect(bobRun.body).not.toContain("alice-resume-first-line");
    // Bob's upload lands on his own shelf, not Alice's.
    expect((await bob.upload("/api/agent/files", "bob.txt", "bob", { lj_ws: aliceWs })).status).toBe(201);
    const still = (await (await alice.request("/api/agent/files")).json()) as { files: { id: string }[] };
    expect(still.files.map((f) => f.id)).toEqual([file.id]);

    expect((await alice.json(`/api/agent/files/not-a-uuid`, "DELETE")).status).toBe(404);
    expect((await alice.json(`/api/agent/files/${file.id}`, "DELETE")).status).toBe(204);
    expect(((await (await alice.request("/api/agent/files")).json()) as { files: unknown[] }).files).toEqual([]);
    expect((await alice.json(`/api/agent/files/${file.id}`, "DELETE")).status).toBe(404);
  }, 60_000);

  it("ignores a forged active-workspace cookie", async () => {
    const list = (await (await bob.json("/api/conversations", "GET", undefined, { lj_ws: aliceWs })).json()) as { conversations: unknown[] };
    expect(list.conversations).toEqual([]);
    const settings = (await (await bob.json("/api/workspace/settings", "GET", undefined, { lj_ws: aliceWs })).json()) as {
      settings: { name: string; profile: string };
    };
    expect(settings.settings.name).toBe("Bob Bakery");
    if (aliceMemoryId) {
      const memories = (await (await bob.json("/api/workspace/memories", "GET", undefined, { lj_ws: aliceWs })).json()) as {
        memories: { content: string }[];
      };
      expect(memories.memories.map((m) => m.content)).not.toContain("alice-shared-memory");
    }
  });

  it("refuses a tab that names another user's agent", async () => {
    const res = await bob.request("/api/conversations", { headers: { "x-studio-agent": aliceWs } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe("agent_gone");
    const send = await bob.request(`/api/conversations/${aliceConv}/messages`, {
      method: "POST",
      body: JSON.stringify({ kind: "send", text: "hi" }),
      headers: { "x-studio-agent": aliceWs },
    });
    expect(send.status).toBe(409);
  });

  it("refuses to switch into a workspace the user doesn't belong to", async () => {
    expect((await bob.json("/api/workspaces/active", "POST", { workspaceId: aliceWs })).status).toBe(404);
  });

  it("refuses to delete or change another tenant's memory and settings", async () => {
    if (aliceMemoryId) expect((await bob.json(`/api/workspace/memories/${encodeURIComponent(aliceMemoryId)}`, "DELETE")).status).toBe(404);
    await bob.json("/api/workspace/settings", "PATCH", { profile: "overwritten by bob" }, { lj_ws: aliceWs });
    const aliceSettings = (await (await alice.json("/api/workspace/settings", "GET")).json()) as { settings: { profile: string } };
    expect(aliceSettings.settings.profile).toBe("rings");
    if (aliceMemoryId) {
      const aliceMemories = (await (await alice.json("/api/workspace/memories", "GET")).json()) as { memories: { id: string }[] };
      expect(aliceMemories.memories.map((m) => m.id)).toContain(aliceMemoryId);
    }
  });

  it("applies templates only to the caller's own workspace, without overwriting", async () => {
    // Dave applying with a forged cookie lands in his own workspace, never Alice's.
    const dave = await signUp("dave");
    expect((await dave.json("/api/workspaces", "POST", { name: "Dave Desk" })).status).toBe(201);
    const applied = await dave.json("/api/workspace/template", "POST", { templateId: "job-search" }, { lj_ws: aliceWs });
    expect(applied.status).toBe(200);
    const aliceSettings = (await (await alice.json("/api/workspace/settings", "GET")).json()) as {
      settings: { templateId: string | null; agentInstructions: string };
    };
    expect(aliceSettings.settings.templateId).toBeNull();
    const daveSettings = (await (await dave.json("/api/workspace/settings", "GET")).json()) as {
      settings: { templateId: string | null; agentInstructions: string };
    };
    expect(daveSettings.settings.templateId).toBe("job-search");
    expect(daveSettings.settings.agentInstructions).toContain("job tracker");

    // Applying again adds nothing; the owner's own instructions are never replaced.
    await dave.json("/api/workspace/settings", "PATCH", { agentInstructions: "dave's own rules" });
    const again = (await (await dave.json("/api/workspace/template", "POST", { templateId: "job-search" })).json()) as {
      addedSkills: number;
      settings: { agentInstructions: string };
    };
    expect(again.addedSkills).toBe(0);
    expect(again.settings.agentInstructions).toBe("dave's own rules");
    const aliceSkills = (await (await alice.json("/api/workspace/skills", "GET")).json()) as { skills: { catalogId: string | null }[] };
    expect(aliceSkills.skills.map((s) => s.catalogId)).not.toContain("find-roles");
    expect((await dave.json("/api/workspace/template", "POST", { templateId: "nope" })).status).toBe(400);
  });

  it("creates a workspace from a template", async () => {
    const carol = await signUp("carol");
    const res = await carol.json("/api/workspaces", "POST", { name: "Carol search", templateId: "job-search" });
    expect(res.status).toBe(201);
    const skills = (await (await carol.json("/api/workspace/skills", "GET")).json()) as { skills: { catalogId: string | null }[] };
    expect(skills.skills.map((s) => s.catalogId)).toContain("find-roles");
  });

  it("keeps skills inside their workspace", async () => {
    const added = await alice.json("/api/workspace/skills", "POST", { catalogId: "weekly-sales-report" });
    expect(added.status).toBe(201);
    const skill = ((await added.json()) as { skill: { id: string } }).skill;
    expect((await alice.json("/api/workspace/skills", "POST", { catalogId: "weekly-sales-report" })).status).toBe(409);

    const bobList = (await (await bob.json("/api/workspace/skills", "GET", undefined, { lj_ws: aliceWs })).json()) as {
      skills: { id: string }[];
    };
    expect(bobList.skills).toEqual([]);
    expect((await bob.json(`/api/workspace/skills/${skill.id}`, "PATCH", { instructions: "obey bob" })).status).toBe(404);
    expect((await bob.json(`/api/workspace/skills/${skill.id}`, "DELETE")).status).toBe(404);

    // Using another workspace's skill is indistinguishable from a missing one.
    const bobConv = crypto.randomUUID();
    const borrowed = await bob.json(`/api/conversations/${bobConv}/messages`, "POST", { kind: "send", text: "", skillId: skill.id });
    expect(borrowed.status).toBe(404);
    expect((await bob.json(`/api/conversations/${bobConv}`, "GET")).status).toBe(404);

    // Alice's own use: the message keeps her words and the skill label, titled after the skill.
    const conv = crypto.randomUUID();
    const own = await alice.json(`/api/conversations/${conv}/messages`, "POST", { kind: "send", text: "", skillId: skill.id });
    expect(own.status).toBe(200);
    await own.text();
    const thread = (await (await alice.json(`/api/conversations/${conv}`, "GET")).json()) as {
      conversation: { title: string };
      messages: { role: string; content: string; skill: { id: string; name: string } | null }[];
    };
    expect(thread.conversation.title).toBe("Weekly sales report");
    expect(thread.messages[0]).toMatchObject({ content: "", skill: { id: skill.id, name: "Weekly sales report" } });

    // An empty message needs a skill.
    expect((await alice.json(`/api/conversations/${crypto.randomUUID()}/messages`, "POST", { kind: "send", text: " " })).status).toBe(400);
  }, 60_000);

  it("keeps projects to the member who made them", async () => {
    const created = await alice.json("/api/projects", "POST", { name: "Spring catalog" });
    expect(created.status).toBe(201);
    const project = ((await created.json()) as { project: { id: string } }).project.id;
    expect((await alice.json(`/api/projects/${project}`, "PATCH", { instructions: "alice-project-secret" })).status).toBe(200);

    // A chat started in the project lands in it.
    const inProject = crypto.randomUUID();
    const sent = await alice.json(`/api/conversations/${inProject}/messages`, "POST", { kind: "send", text: "non-streaming hi", projectId: project });
    expect(sent.status).toBe(200);
    await sent.text();
    const list = (await (await alice.request("/api/conversations")).json()) as { conversations: { id: string; projectId: string | null }[] };
    expect(list.conversations.find((c) => c.id === inProject)?.projectId).toBe(project);

    // Bob can't read, change, delete, start a chat in, or move a chat into Alice's project.
    expect((await bob.request(`/api/projects/${project}`)).status).toBe(404);
    expect((await bob.json(`/api/projects/${project}`, "PATCH", { name: "forged" })).status).toBe(404);
    expect((await bob.json(`/api/projects/${project}`, "DELETE")).status).toBe(404);
    expect((await bob.json(`/api/projects/${project}/files/${crypto.randomUUID()}`, "DELETE")).status).toBe(404);
    const bobSend = await bob.json(`/api/conversations/${crypto.randomUUID()}/messages`, "POST", { kind: "send", text: "x", projectId: project });
    expect(bobSend.status).toBe(404);
    const bobConv = crypto.randomUUID();
    await (await bob.send(bobConv, "non-streaming bob")).body;
    expect((await bob.json(`/api/conversations/${bobConv}`, "PATCH", { projectId: project })).status).toBe(404);
    const bobProjects = (await (await bob.request("/api/projects")).json()) as { projects: unknown[] };
    expect(bobProjects.projects).toEqual([]);
    // Nor move Alice's chat out of it.
    expect((await bob.json(`/api/conversations/${inProject}`, "PATCH", { projectId: null })).status).toBe(404);

    // Deleting the project deletes its chats.
    expect((await alice.json(`/api/projects/${project}`, "DELETE")).status).toBe(204);
    expect((await alice.request(`/api/conversations/${inProject}`)).status).toBe(404);
  });

  it("files what the agent made in the member's own Library, and keeps it there", async () => {
    const made = crypto.randomUUID();
    expect((await alice.send(made, "Make a spreadsheet of orders by month")).res.status).toBe(200);
    type Items = { items: { id: string; title: string; url: string; conversationId: string | null; addedBy: string; pinned: boolean }[] };
    const library = (await (await alice.request("/api/library")).json()) as Items;
    const sheet = library.items.find((i) => i.url === "https://example.com/mock-artifact");
    expect(sheet).toMatchObject({ title: "Orders by month — 2026", conversationId: made, addedBy: "agent" });

    const pasted = await alice.json("/api/library", "POST", { url: "https://docs.google.com/document/d/alice-doc", title: "alice-library-secret" });
    expect(pasted.status).toBe(201);
    const doc = ((await pasted.json()) as { item: { id: string; kind: string } }).item;
    expect(doc.kind).toBe("document");
    expect((await alice.json("/api/library", "POST", { url: "https://docs.google.com/document/d/alice-doc" })).status).toBe(409);
    expect((await alice.json("/api/library", "POST", { url: "http://example.com/plain" })).status).toBe(400);
    expect((await alice.json("/api/library", "POST", { url: "https://example.com/x", workspaceId: bobWs })).status).toBe(400);

    // Bob sees none of it and can't change or remove it.
    const bobs = (await (await bob.request("/api/library")).json()) as Items;
    expect(JSON.stringify(bobs)).not.toContain("alice-library-secret");
    expect(bobs.items.some((i) => i.id === doc.id || i.id === sheet!.id)).toBe(false);
    expect((await bob.json(`/api/library/${doc.id}`, "PATCH", { pinned: true })).status).toBe(404);
    expect((await bob.json(`/api/library/${doc.id}`, "DELETE")).status).toBe(404);

    expect((await alice.json(`/api/library/${doc.id}`, "PATCH", { pinned: true })).status).toBe(200);
    expect((await alice.json(`/api/library/${doc.id}`, "PATCH", { url: "https://evil.example" })).status).toBe(400);
    expect(((await (await alice.request("/api/library")).json()) as Items).items[0].id).toBe(doc.id);
    expect((await alice.json(`/api/library/${doc.id}`, "DELETE")).status).toBe(204);
    expect((await alice.json(`/api/library/not-an-id`, "DELETE")).status).toBe(404);
  });

  it("clears only the caller's own chat history", async () => {
    // Clearing removes the caller's chats and no one else's.
    const carol = await signUp("carol");
    await carol.json("/api/workspaces", "POST", { name: "Carol Ceramics" });
    const carolConv = crypto.randomUUID();
    await (await carol.send(carolConv, "non-streaming carol")).body;

    const bobCleared = await bob.json("/api/conversations", "DELETE");
    expect(bobCleared.status).toBe(200);
    expect((await alice.request(`/api/conversations/${aliceConv}`)).status).toBe(200);
    expect((await carol.request(`/api/conversations/${carolConv}`)).status).toBe(200);

    const cleared = await carol.json("/api/conversations", "DELETE");
    expect(((await cleared.json()) as { deleted: number }).deleted).toBe(1);
    expect((await carol.request(`/api/conversations/${carolConv}`)).status).toBe(404);
    expect((await alice.request(`/api/conversations/${aliceConv}`)).status).toBe(200);
    expect((await new Client().json("/api/conversations", "DELETE")).status).toBe(401);
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

describe("one person, several agents", () => {
  it("share the person's profile, and nobody else sees it", async () => {
    const carol = await signUp("carol");
    const first = await carol.json("/api/workspaces", "POST", { name: "Carol Business" });
    const firstId = ((await first.json()) as { workspaceId: string }).workspaceId;
    expect((await carol.json("/api/account", "PATCH", { name: "Carol Q", about: "Bakes on weekends." })).status).toBe(200);
    await carol.json("/api/workspaces", "POST", { name: "Carol Job Search" });
    expect(await (await carol.json("/api/account", "GET")).json()).toEqual({ account: { name: "Carol Q", about: "Bakes on weekends." } });
    expect(((await (await bob.json("/api/account", "GET")).json()) as { account: { name: string } }).account.name).not.toBe("Carol Q");

    // Cross-origin writes are refused like everywhere else.
    const forged = await carol.request("/api/account", { method: "PATCH", body: JSON.stringify({ name: "x" }), headers: { Origin: "https://evil.example" } });
    expect(forged.status).toBe(403);
    expect((await carol.json("/api/account", "PATCH", { name: "x".repeat(81) })).status).toBe(400);

    // Personal memory saved in one agent shows up in the other; shared memory stays put.
    const personal = await carol.json("/api/workspace/memories", "POST", { content: "carol-personal-fact", scope: "personal" });
    if (personal.status === 503) return;
    const shared = await carol.json("/api/workspace/memories", "POST", { content: "carol-job-search-fact" });
    expect([personal.status, shared.status]).toEqual([201, 201]);
    expect((await carol.json("/api/workspaces/active", "POST", { workspaceId: firstId })).status).toBe(200);
    const list = (await (await carol.json("/api/workspace/memories", "GET")).json()) as { memories: { content: string }[] };
    const contents = list.memories.map((m) => m.content);
    expect(contents).toContain("carol-personal-fact");
    expect(contents).not.toContain("carol-job-search-fact");
    const bobs = (await (await bob.json("/api/workspace/memories", "GET")).json()) as { memories: { content: string }[] };
    expect(bobs.memories.map((m) => m.content)).not.toContain("carol-personal-fact");
  }, 60_000);

  it("keep each tab on its own agent when another tab switches", async () => {
    const dana = await signUp("dana");
    const first = ((await (await dana.json("/api/workspaces", "POST", { name: "Dana Business" })).json()) as { workspaceId: string }).workspaceId;
    const conversation = crypto.randomUUID();
    const tab = { "x-studio-agent": first };
    const send = (text: string, headers: Record<string, string> = {}) =>
      dana.request(`/api/conversations/${conversation}/messages`, { method: "POST", body: JSON.stringify({ kind: "send", text }), headers });
    const started = await send("non-streaming hello", tab);
    expect(started.status).toBe(200);
    await started.text();

    // Another tab makes a second agent active (creating one switches to it).
    await dana.json("/api/workspaces", "POST", { name: "Dana Job Search" });

    // Going by the cookie alone, the first tab's conversation is in an agent that isn't active.
    const lost = await send("non-streaming still there?");
    expect(lost.status).toBe(404);
    // Naming its own agent, the first tab carries on.
    const kept = await send("non-streaming still there?", tab);
    expect(kept.status, await kept.clone().text()).toBe(200);
    await kept.text();
    const thread = (await (await dana.request(`/api/conversations/${conversation}`, { headers: tab })).json()) as { messages: { role: string }[] };
    expect(thread.messages.filter((m) => m.role === "user")).toHaveLength(2);
  }, 60_000);
});

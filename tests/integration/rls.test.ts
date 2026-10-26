import { beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createStore } from "@/lib/db/store";
import { createAccount, createWorkspace, SUPABASE_URL, type TestAccount } from "./helpers";

// Database-level tenant isolation. Two independent accounts each own a workspace with a
// conversation, messages, and memories; each test attempts to reach the other tenant's data
// directly through PostgREST with a valid session, i.e. the strongest attacker the app
// can face short of stealing a session.

let alice: TestAccount;
let bob: TestAccount;
let aliceWs: string;
let bobWs: string;
const aliceConv = crypto.randomUUID();

beforeAll(async () => {
  alice = await createAccount("alice");
  bob = await createAccount("bob");
  aliceWs = await createWorkspace(alice, "Alice Atelier");
  bobWs = await createWorkspace(bob, "Bob Bakery");

  const conv = await alice.client
    .from("conversations")
    .insert({ id: aliceConv, workspace_id: aliceWs, user_id: alice.userId, title: "Alice secret plans" });
  expect(conv.error).toBeNull();
  const msg = await alice.client.from("messages").insert({
    conversation_id: aliceConv,
    workspace_id: aliceWs,
    user_id: alice.userId,
    role: "user",
    content: "alice-private-message",
    status: "complete",
  });
  expect(msg.error).toBeNull();
  const mem = await alice.client
    .from("memories")
    .insert({ workspace_id: aliceWs, content: "alice-shared-memory", created_by: alice.userId });
  expect(mem.error).toBeNull();
});

describe("row level security", () => {
  it("lets each user see only their own workspace", async () => {
    const a = await alice.client.from("workspaces").select("id,name");
    const b = await bob.client.from("workspaces").select("id,name");
    expect(a.data?.map((w) => w.id)).toEqual([aliceWs]);
    expect(b.data?.map((w) => w.id)).toEqual([bobWs]);
  });

  it("hides another tenant's conversations, messages, memories, settings, and membership", async () => {
    for (const [table, column, value] of [
      ["conversations", "id", aliceConv],
      ["messages", "conversation_id", aliceConv],
      ["memories", "workspace_id", aliceWs],
      ["workspace_settings", "workspace_id", aliceWs],
      ["workspace_members", "workspace_id", aliceWs],
      ["workspaces", "id", aliceWs],
    ] as const) {
      const { data, error } = await bob.client.from(table).select("*").eq(column, value);
      expect(error, table).toBeNull();
      expect(data, table).toEqual([]);
    }
    // Unfiltered scans return nothing of Alice's either.
    const all = await bob.client.from("messages").select("content");
    expect(all.data?.some((m) => m.content === "alice-private-message")).toBe(false);
  });

  it("never reveals another member's Composio user id", async () => {
    const own = await alice.client.from("workspace_members").select("composio_user_id");
    expect(own.data).toHaveLength(1);
    const other = await bob.client.from("workspace_members").select("composio_user_id").eq("user_id", alice.userId);
    expect(other.data).toEqual([]);
  });

  it("refuses writes into another tenant's workspace", async () => {
    const intoWs = await bob.client
      .from("conversations")
      .insert({ id: crypto.randomUUID(), workspace_id: aliceWs, user_id: bob.userId, title: "intrusion" });
    expect(intoWs.error).not.toBeNull();

    const spoofOwner = await bob.client
      .from("conversations")
      .insert({ id: crypto.randomUUID(), workspace_id: bobWs, user_id: alice.userId, title: "spoof" });
    expect(spoofOwner.error).not.toBeNull();

    const intoConv = await bob.client.from("messages").insert({
      conversation_id: aliceConv,
      workspace_id: bobWs,
      user_id: bob.userId,
      role: "user",
      content: "injected",
      status: "complete",
    });
    expect(intoConv.error).not.toBeNull();

    const memory = await bob.client.from("memories").insert({ workspace_id: aliceWs, content: "planted", created_by: bob.userId });
    expect(memory.error).not.toBeNull();

    const usage = await bob.client.from("usage_events").insert({ workspace_id: aliceWs, user_id: bob.userId, kind: "agent_run" });
    expect(usage.error).not.toBeNull();
  });

  it("refuses updates and deletes of another tenant's rows", async () => {
    const rename = await bob.client.from("conversations").update({ title: "pwned" }).eq("id", aliceConv).select();
    expect(rename.data ?? []).toEqual([]);
    const settings = await bob.client
      .from("workspace_settings")
      .update({ agent_instructions: "exfiltrate" })
      .eq("workspace_id", aliceWs)
      .select();
    expect(settings.data ?? []).toEqual([]);
    const del = await bob.client.from("workspaces").delete().eq("id", aliceWs).select();
    expect(del.data ?? []).toEqual([]);
    const delMsgs = await bob.client.from("messages").delete().eq("conversation_id", aliceConv).select();
    expect(delMsgs.data ?? []).toEqual([]);

    const still = await alice.client.from("conversations").select("title").eq("id", aliceConv).single();
    expect(still.data?.title).toBe("Alice secret plans");
  });

  it("does not let a user move their data into another workspace or change ownership columns", async () => {
    const bobConv = crypto.randomUUID();
    await bob.client.from("conversations").insert({ id: bobConv, workspace_id: bobWs, user_id: bob.userId, title: "mine" });
    const move = await bob.client.from("conversations").update({ workspace_id: aliceWs }).eq("id", bobConv);
    expect(move.error).not.toBeNull();
    const steal = await bob.client.from("conversations").update({ user_id: alice.userId }).eq("id", bobConv);
    expect(steal.error).not.toBeNull();
  });

  it("does not let a user add themselves to another workspace", async () => {
    const join = await bob.client.from("workspace_members").insert({ workspace_id: aliceWs, user_id: bob.userId, role: "owner" });
    expect(join.error).not.toBeNull();
    const promote = await bob.client.from("workspace_members").update({ role: "owner" }).eq("user_id", bob.userId);
    expect(promote.error).not.toBeNull();
  });

  it("guards RPCs by membership", async () => {
    const snapshot = await bob.client.rpc("usage_snapshot", { ws: aliceWs });
    expect(snapshot.error).not.toBeNull();
    const own = await bob.client.rpc("usage_snapshot", { ws: bobWs });
    expect(own.error).toBeNull();
  });

  it("answers the service-wide cap with a yes/no, never other tenants' rows", async () => {
    const run = await alice.client.from("usage_events").insert({ workspace_id: aliceWs, user_id: alice.userId, kind: "agent_run" });
    expect(run.error).toBeNull();
    // Bob can't see Alice's run, but it counts toward the service-wide cap.
    const visible = await bob.client.from("usage_events").select("id").eq("workspace_id", aliceWs);
    expect(visible.data).toEqual([]);
    const atOne = await bob.client.rpc("service_runs_at_limit", { p_limit: 1 });
    expect(atOne).toMatchObject({ error: null, data: true });
    const roomy = await bob.client.rpc("service_runs_at_limit", { p_limit: 1_000_000 });
    expect(roomy).toMatchObject({ error: null, data: false });
  });

  it("limits how many workspaces one account can create", async () => {
    await createWorkspace(bob, "Second");
    await createWorkspace(bob, "Third");
    await createWorkspace(bob, "Fourth");
    await createWorkspace(bob, "Fifth");
    await expect(createWorkspace(bob, "Sixth")).rejects.toMatchObject({ message: "workspace limit reached" });
  });

  it("gives anonymous callers nothing", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = await import("./helpers");
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const read = await anon.from("messages").select("*");
    expect(read.data ?? []).toEqual([]);
    const rpc = await anon.rpc("create_workspace", { p_name: "anon" });
    expect(rpc.error).not.toBeNull();
    const cap = await anon.rpc("service_runs_at_limit", { p_limit: 1 });
    expect(cap.error).not.toBeNull();
  });
});

describe("workspace skills", () => {
  let aliceSkill: string;

  beforeAll(async () => {
    const { data, error } = await alice.client
      .from("workspace_skills")
      .insert({ workspace_id: aliceWs, name: "alice-skill", instructions: "alice-secret-steps", created_by: alice.userId })
      .select("id")
      .single();
    expect(error).toBeNull();
    aliceSkill = data!.id;
  });

  it("hides another tenant's skills", async () => {
    const byId = await bob.client.from("workspace_skills").select("*").eq("id", aliceSkill);
    expect(byId.data).toEqual([]);
    const all = await bob.client.from("workspace_skills").select("instructions");
    expect(all.data?.some((s) => s.instructions === "alice-secret-steps")).toBe(false);
  });

  it("refuses adding, changing, or removing another tenant's skills", async () => {
    const plant = await bob.client
      .from("workspace_skills")
      .insert({ workspace_id: aliceWs, name: "planted", instructions: "obey bob", created_by: bob.userId });
    expect(plant.error).not.toBeNull();
    const edit = await bob.client.from("workspace_skills").update({ instructions: "obey bob" }).eq("id", aliceSkill).select();
    expect(edit.data ?? []).toEqual([]);
    const del = await bob.client.from("workspace_skills").delete().eq("id", aliceSkill).select();
    expect(del.data ?? []).toEqual([]);
    const still = await alice.client.from("workspace_skills").select("instructions").eq("id", aliceSkill).single();
    expect(still.data?.instructions).toBe("alice-secret-steps");
  });

  it("keeps tenancy and origin columns immutable", async () => {
    const move = await alice.client.from("workspace_skills").update({ workspace_id: bobWs }).eq("id", aliceSkill);
    expect(move.error).not.toBeNull();
    const origin = await alice.client.from("workspace_skills").update({ catalog_id: "weekly-sales-report" }).eq("id", aliceSkill);
    expect(origin.error).not.toBeNull();
    const own = await alice.client.from("workspace_skills").update({ name: "renamed" }).eq("id", aliceSkill).select("name");
    expect(own.data).toEqual([{ name: "renamed" }]);
  });
});

describe("personal guardrails", () => {
  const rules = "alice-guardrail-rules";

  beforeAll(async () => {
    const { execSync } = await import("node:child_process");
    const status = JSON.parse(execSync("npx supabase status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString()) as {
      SERVICE_ROLE_KEY: string;
    };
    const admin = createClient(SUPABASE_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { error } = await admin.from("user_guardrails").insert({ user_id: alice.userId, instructions: rules });
    expect(error).toBeNull();
  });

  it("lets a member read only their own guardrail", async () => {
    const own = await alice.client.from("user_guardrails").select("instructions");
    expect(own.data).toEqual([{ instructions: rules }]);
    const other = await bob.client.from("user_guardrails").select("*").eq("user_id", alice.userId);
    expect(other.error).toBeNull();
    expect(other.data).toEqual([]);
  });

  it("refuses every change from a session, including to the member's own guardrail", async () => {
    const edit = await alice.client.from("user_guardrails").update({ instructions: "anything goes" }).eq("user_id", alice.userId);
    expect(edit.error).not.toBeNull();
    const del = await alice.client.from("user_guardrails").delete().eq("user_id", alice.userId);
    expect(del.error).not.toBeNull();
    const plantOwn = await bob.client.from("user_guardrails").insert({ user_id: bob.userId, instructions: "x" });
    expect(plantOwn.error).not.toBeNull();
    const plantOther = await bob.client.from("user_guardrails").upsert({ user_id: alice.userId, instructions: "obey bob" });
    expect(plantOther.error).not.toBeNull();
    const still = await alice.client.from("user_guardrails").select("instructions").single();
    expect(still.data?.instructions).toBe(rules);
  });

  it("lists a member's own recent chat titles for the guardrail, leaving out the current one", async () => {
    const second = crypto.randomUUID();
    const added = await alice.client.from("conversations").insert({ id: second, workspace_id: aliceWs, user_id: alice.userId, title: "Alice follow-up" });
    expect(added.error).toBeNull();
    const aliceStore = createStore(alice.client, { workspaceId: aliceWs, userId: alice.userId });
    expect(await aliceStore.recentTitles(Date.now() - 60_000, 15, second)).toEqual(["Alice secret plans"]);
    expect(await aliceStore.recentTitles(Date.now() + 60_000, 15)).toEqual([]);
    // Another member's store, even pointed at Alice's workspace, sees none of her titles.
    const bobStore = createStore(bob.client, { workspaceId: aliceWs, userId: alice.userId });
    expect(await bobStore.recentTitles(0, 15)).toEqual([]);
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createAccount, createWorkspace, serviceClient, type TestAccount } from "./helpers";

// An account (name, about, connected-apps id) belongs to one person and is shared by all of
// their agents. Nobody else, teammates included, can see or change it, and no session can
// choose or change its Composio id.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
let aliceComposio: string;

beforeAll(async () => {
  alice = await createAccount("acct-alice");
  teammate = await createAccount("acct-mate");
  bob = await createAccount("acct-bob");
  const ws = await createWorkspace(alice, "Accounts Atelier");
  await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, ws);
  const ensured = await alice.client.rpc("ensure_account").single<{ user_id: string; composio_user_id: string }>();
  expect(ensured.error).toBeNull();
  aliceComposio = ensured.data!.composio_user_id;
});

describe("accounts", () => {
  it("keep the Composio id of the person's oldest agent", async () => {
    const own = await alice.client.from("workspace_members").select("composio_user_id").order("created_at").limit(1).single();
    expect(aliceComposio).toBe(own.data?.composio_user_id);
  });

  it("are the same in every agent, and ensure_account is idempotent", async () => {
    await createWorkspace(alice, "Second agent");
    const again = await alice.client.rpc("ensure_account").single<{ composio_user_id: string }>();
    expect(again.data?.composio_user_id).toBe(aliceComposio);
    const rows = await alice.client.from("accounts").select("user_id, composio_user_id");
    expect(rows.data).toEqual([{ user_id: alice.userId, composio_user_id: aliceComposio }]);
  });

  it("are created for someone with no agent yet", async () => {
    const fresh = await createAccount("acct-fresh");
    const made = await fresh.client.rpc("ensure_account").single<{ user_id: string; composio_user_id: string }>();
    expect(made.data?.user_id).toBe(fresh.userId);
    expect(made.data?.composio_user_id).toMatch(/^lj_[0-9a-f]{32}$/);
  });

  it("resolve in one round trip with the person's agents, oldest first", async () => {
    const mine = await alice.client.rpc("resolve_tenant");
    expect(mine.error).toBeNull();
    const resolved = mine.data as { account: { composio_user_id: string; display_name: string }; memberships: { workspace_id: string; role: string; name: string }[] };
    expect(resolved.account.composio_user_id).toBe(aliceComposio);
    expect(resolved.memberships.map((m) => [m.name, m.role])).toEqual([
      ["Accounts Atelier", "owner"],
      ["Second agent", "owner"],
    ]);
    // A teammate sees their own account and membership, never the owner's.
    const theirs = await teammate.client.rpc("resolve_tenant");
    const other = theirs.data as typeof resolved;
    expect(other.account.composio_user_id).not.toBe(aliceComposio);
    expect(other.memberships).toEqual([{ workspace_id: resolved.memberships[0].workspace_id, role: "member", name: "Accounts Atelier", on_home: true }]);
    // Someone with no agent yet gets an account and no memberships.
    const fresh = await createAccount("acct-none");
    const none = (await fresh.client.rpc("resolve_tenant")).data as typeof resolved;
    expect(none.account.composio_user_id).toMatch(/^lj_[0-9a-f]{32}$/);
    expect(none.memberships).toEqual([]);
  });

  it("are visible only to their owner", async () => {
    for (const other of [teammate, bob]) {
      expect((await other.client.from("accounts").select("user_id").eq("user_id", alice.userId)).data).toEqual([]);
    }
  });

  it("let the owner change their name and about, and nothing else", async () => {
    const ok = await alice.client.from("accounts").update({ display_name: "Alice", about: "Runs an atelier." }).eq("user_id", alice.userId).select("display_name");
    expect(ok.data).toEqual([{ display_name: "Alice" }]);
    const steal = await alice.client.from("accounts").update({ composio_user_id: "lj_stolen" }).eq("user_id", alice.userId);
    expect(steal.error).not.toBeNull();
  });

  it("let the owner keep a sealed id for their browser's sign-ins, seen by no one else", async () => {
    const sealed = "ctx_0123456789abcdef.mac";
    const own = await alice.client.from("accounts").update({ browser_context: sealed }).eq("user_id", alice.userId).select("browser_context").single();
    expect(own.data?.browser_context).toBe(sealed);
    for (const other of [teammate, bob]) {
      expect((await other.client.from("accounts").update({ browser_context: "x.y" }).eq("user_id", alice.userId).select("user_id")).data ?? []).toEqual([]);
    }
    expect((await alice.client.from("accounts").update({ browser_context: "x".repeat(201) }).eq("user_id", alice.userId)).error).not.toBeNull();
    expect((await alice.client.from("accounts").update({ browser_context: null }).eq("user_id", alice.userId)).error).toBeNull();
  });

  it("let the owner keep standing OKs of known kinds, seen and changed by no one else", async () => {
    const own = await alice.client.from("accounts").update({ allowed_actions: ["gmail_labels"] }).eq("user_id", alice.userId).select("allowed_actions").single();
    expect(own.data?.allowed_actions).toEqual(["gmail_labels"]);
    for (const other of [teammate, bob]) {
      expect((await other.client.from("accounts").update({ allowed_actions: [] }).eq("user_id", alice.userId).select("user_id")).data ?? []).toEqual([]);
      expect((await other.client.from("accounts").select("allowed_actions").eq("user_id", alice.userId)).data).toEqual([]);
    }
    expect((await alice.client.from("accounts").update({ allowed_actions: ["send_email"] }).eq("user_id", alice.userId)).error).not.toBeNull();
    // A use case: one app tool, or paying on one site (src/lib/approvals/standing.ts).
    const kinds = ["gmail_labels", "tool:STRIPE_CREATE_REFUND", "site:usps.com"];
    const cases = await alice.client.from("accounts").update({ allowed_actions: kinds }).eq("user_id", alice.userId).select("allowed_actions").single();
    expect(cases.data?.allowed_actions).toEqual(kinds);
    for (const bad of ["tool:stripe_refund", "tool:STRIPE", "site:http://usps.com", "site:USPS.COM", "site:usps"]) {
      expect((await alice.client.from("accounts").update({ allowed_actions: [bad] }).eq("user_id", alice.userId)).error).not.toBeNull();
    }
    expect((await alice.client.from("accounts").update({ allowed_actions: [] }).eq("user_id", alice.userId)).error).toBeNull();
  });

  it("can't be changed, created, or removed by anyone else", async () => {
    for (const other of [teammate, bob]) {
      const update = await other.client.from("accounts").update({ display_name: "Mallory" }).eq("user_id", alice.userId).select("user_id");
      expect(update.data ?? []).toEqual([]);
      const removed = await other.client.from("accounts").delete().eq("user_id", alice.userId).select("user_id");
      expect(removed.data ?? []).toEqual([]);
    }
    const forged = await bob.client.from("accounts").insert({ user_id: alice.userId, composio_user_id: "lj_forged" });
    expect(forged.error).not.toBeNull();
    const own = await bob.client.from("accounts").insert({ user_id: bob.userId, composio_user_id: "lj_chosen" });
    expect(own.error).not.toBeNull();

    const admin = await serviceClient();
    const row = await admin.from("accounts").select("display_name, composio_user_id").eq("user_id", alice.userId).single();
    expect(row.data).toEqual({ display_name: "Alice", composio_user_id: aliceComposio });
  });
});

describe("tenancy", () => {
  it("gives every agent of one person the same Composio id and profile", async () => {
    const { resolveTenant, sessionFor } = await import("@/lib/tenant-core");
    const session = sessionFor(alice.client as never, { id: alice.userId });
    const all = (await resolveTenant(session))!.workspaces;
    expect(all.length).toBeGreaterThan(1);
    const tenants = await Promise.all(all.map((w) => resolveTenant(session, w.id)));
    expect(new Set(tenants.map((t) => t!.workspace.id)).size).toBe(all.length);
    expect(tenants.map((t) => t!.composioUserId)).toEqual(all.map(() => aliceComposio));
    expect(tenants.map((t) => t!.account.name)).toEqual(all.map(() => "Alice"));
  });
});

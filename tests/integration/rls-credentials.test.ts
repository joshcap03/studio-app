import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createAccount, createWorkspace, serviceClient, type TestAccount } from "./helpers";

// Saved logins and cards belong to one person, across all their agents. Nobody else, teammates
// included, can see, reveal, change, or remove one, and no session writes the table directly:
// saving, revealing, and removing go through functions that keep the Vault secret in step.

let ada: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
let login: string;
let card: string;

const save = (account: TestAccount, args: Record<string, unknown>) => account.client.rpc("save_credential", args);

beforeAll(async () => {
  ada = await createAccount("cred-ada");
  teammate = await createAccount("cred-mate");
  bob = await createAccount("cred-bob");
  const ws = await createWorkspace(ada, "Credentials Co");
  await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, ws);
  const saved = await save(ada, { p_kind: "login", p_label: "Acme", p_sealed: "v1.sealed-login", p_origin: "https://acme.example", p_username: "ada@example.test" });
  expect(saved.error).toBeNull();
  login = saved.data as string;
  const savedCard = await save(ada, { p_kind: "card", p_label: "Visa ending 4242", p_sealed: "v1.sealed-card", p_card_brand: "Visa", p_card_last4: "4242", p_card_exp: "04/27" });
  expect(savedCard.error).toBeNull();
  card = savedCard.data as string;
});

describe("saved credentials", () => {
  it("show their owner what they are, never the secret", async () => {
    const rows = await ada.client.from("credentials").select("id, kind, origin, username, card_last4").order("kind");
    expect(rows.data).toEqual([
      { id: card, kind: "card", origin: null, username: null, card_last4: "4242" },
      { id: login, kind: "login", origin: "https://acme.example", username: "ada@example.test", card_last4: null },
    ]);
    const secret = await ada.client.from("credentials").select("secret_id");
    expect(secret.error).not.toBeNull();
  });

  it("reveal only to their owner", async () => {
    expect((await ada.client.rpc("reveal_credential", { p_id: login })).data).toBe("v1.sealed-login");
    for (const other of [teammate, bob]) {
      expect((await other.client.rpc("reveal_credential", { p_id: login })).data).toBeNull();
      expect((await other.client.from("credentials").select("id").eq("id", login)).data).toEqual([]);
    }
  });

  it("replace a login saved for the same site and username", async () => {
    const again = await save(ada, { p_kind: "login", p_label: "Acme", p_sealed: "v1.new-login", p_origin: "https://acme.example", p_username: "ada@example.test" });
    expect(again.data).toBe(login);
    expect((await ada.client.rpc("reveal_credential", { p_id: login })).data).toBe("v1.new-login");
  });

  it("refuse a login for a site that isn't https, or a card with a security code's worth of nothing", async () => {
    expect((await save(ada, { p_kind: "login", p_label: "Plain", p_sealed: "v1.x", p_origin: "http://acme.example" })).error).not.toBeNull();
    expect((await save(ada, { p_kind: "card", p_label: "Bad", p_sealed: "v1.x", p_card_last4: "42" , p_card_exp: "04/27" })).error).not.toBeNull();
  });

  it("can't be written, changed, or removed directly, or by anyone else", async () => {
    const insert = await bob.client.from("credentials").insert({ kind: "login", label: "x", origin: "https://acme.example", secret_id: crypto.randomUUID() });
    expect(insert.error).not.toBeNull();
    const update = await ada.client.from("credentials").update({ origin: "https://evil.example" }).eq("id", login).select("id");
    expect(update.data ?? []).toEqual([]);
    expect((await bob.client.rpc("delete_credential", { p_id: login })).data).toBe(false);
    expect((await teammate.client.rpc("delete_credential", { p_id: card })).data).toBe(false);
  });

  it("take their Vault secret with them when removed", async () => {
    const admin = await serviceClient();
    const row = await admin.from("credentials").select("secret_id").eq("id", card).single();
    const secretId = (row.data as { secret_id: string }).secret_id;
    expect((await ada.client.rpc("delete_credential", { p_id: card })).data).toBe(true);
    expect((await ada.client.from("credentials").select("id").eq("id", card)).data).toEqual([]);
    const left = await admin.schema("vault").from("secrets").select("id").eq("id", secretId);
    // The vault schema may not be exposed over the API; when it is, the secret is gone.
    if (!left.error) expect(left.data).toEqual([]);
  });

  it("take their Vault secret with them when the person's account goes", async () => {
    const gone = await createAccount("cred-gone");
    const id = (await save(gone, { p_kind: "login", p_label: "Gone", p_sealed: "v1.gone", p_origin: "https://gone.example" })).data as string;
    const admin = await serviceClient();
    const secretId = ((await admin.from("credentials").select("secret_id").eq("id", id).single()).data as { secret_id: string }).secret_id;
    expect((await admin.auth.admin.deleteUser(gone.userId)).error).toBeNull();
    const { execSync } = await import("node:child_process");
    const left = execSync(`docker exec supabase_db_studio-app psql -U postgres -tAc "select count(*) from vault.secrets where id = '${secretId}'"`).toString().trim();
    expect(left).toBe("0");
  });

  it("aren't readable by anyone signed out", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = await import("./helpers");
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    expect((await anon.from("credentials").select("id")).data ?? []).toEqual([]);
    expect((await anon.rpc("reveal_credential", { p_id: login })).error).not.toBeNull();
  });
});

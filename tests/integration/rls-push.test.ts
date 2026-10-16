import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createAccount, createWorkspace, type TestAccount } from "./helpers";

// The devices a member gets notifications on are theirs alone: not visible to or changeable
// by other tenants, nor by teammates in the same workspace.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
const endpoint = `https://push.example.test/${crypto.randomUUID()}`;
const device = { endpoint, p256dh: "alice-key", auth: "alice-auth" };

beforeAll(async () => {
  alice = await createAccount("push-alice");
  teammate = await createAccount("push-mate");
  bob = await createAccount("push-bob");
  const ws = await createWorkspace(alice, "Push Atelier");
  await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, ws);
  expect((await alice.client.from("push_subscriptions").insert(device)).error).toBeNull();
});

describe("push subscriptions", () => {
  it("are visible only to their owner", async () => {
    const own = await alice.client.from("push_subscriptions").select("endpoint, p256dh, user_id");
    expect(own.data).toEqual([{ endpoint, p256dh: "alice-key", user_id: alice.userId }]);
    expect((await teammate.client.from("push_subscriptions").select("id")).data).toEqual([]);
    expect((await bob.client.from("push_subscriptions").select("id")).data).toEqual([]);
  });

  it("can't be added for someone else", async () => {
    const forged = await bob.client.from("push_subscriptions").insert({ ...device, endpoint: `${endpoint}-x`, user_id: alice.userId });
    expect(forged.error).not.toBeNull();
  });

  it("can't be changed or removed by anyone else", async () => {
    for (const other of [teammate, bob]) {
      const update = await other.client.from("push_subscriptions").update({ p256dh: "stolen" }).eq("endpoint", endpoint).select("id");
      expect(update.data ?? []).toEqual([]);
      const removed = await other.client.from("push_subscriptions").delete().eq("endpoint", endpoint).select("id");
      expect(removed.data ?? []).toEqual([]);
    }
    const own = await alice.client.from("push_subscriptions").select("p256dh").eq("endpoint", endpoint).single();
    expect(own.data?.p256dh).toBe("alice-key");
  });

  it("let the same device be someone else's too, separately", async () => {
    expect((await bob.client.from("push_subscriptions").insert({ ...device, p256dh: "bob-key" })).error).toBeNull();
    expect((await alice.client.from("push_subscriptions").select("p256dh").eq("endpoint", endpoint).single()).data?.p256dh).toBe("alice-key");
  });

  it("only take https endpoints", async () => {
    expect((await alice.client.from("push_subscriptions").insert({ ...device, endpoint: "http://push.example.test/x" })).error).not.toBeNull();
  });
});

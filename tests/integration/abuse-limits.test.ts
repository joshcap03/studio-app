import { beforeAll, describe, expect, it } from "vitest";
import { createAccount, createWorkspace, type TestAccount } from "./helpers";

// Limits that must hold even when a member skips the app and talks to Supabase directly with
// their own session, or sends many requests at the same moment.

let alice: TestAccount;
let bob: TestAccount;
let aliceWs: string;

beforeAll(async () => {
  alice = await createAccount("alice");
  bob = await createAccount("bob");
  aliceWs = await createWorkspace(alice, "Alice Atelier");
  await createWorkspace(bob, "Bob Bakery");
});

/** Fires `n` claims at once and returns how many were granted. */
async function burst(account: TestAccount, ws: string, n: number, limits: { concurrent: number; perMinute: number; perDay: number }) {
  const results = await Promise.all(
    Array.from({ length: n }, () =>
      account.client.rpc("claim_run", {
        ws,
        p_concurrent: limits.concurrent,
        p_per_minute: limits.perMinute,
        p_per_day: limits.perDay,
        p_message_id: crypto.randomUUID(),
      }),
    ),
  );
  for (const r of results) expect(r.error).toBeNull();
  return { granted: results.filter((r) => r.data === null).length, refusals: new Set(results.map((r) => r.data).filter(Boolean)) };
}

describe("agent run limits", () => {
  it("can't be raced past by a burst of simultaneous requests", async () => {
    const carol = await createAccount("carol");
    const ws = await createWorkspace(carol, "Carol Cafe");
    const concurrent = await burst(carol, ws, 12, { concurrent: 2, perMinute: 100, perDay: 1000 });
    expect(concurrent).toEqual({ granted: 2, refusals: new Set(["concurrent"]) });
  });

  it("holds the per-minute and daily limits under a burst", async () => {
    const dan = await createAccount("dan");
    const ws = await createWorkspace(dan, "Dan Deli");
    expect(await burst(dan, ws, 15, { concurrent: 100, perMinute: 10, perDay: 1000 })).toEqual({ granted: 10, refusals: new Set(["per_minute"]) });

    const erin = await createAccount("erin");
    const ws2 = await createWorkspace(erin, "Erin Eatery");
    expect(await burst(erin, ws2, 8, { concurrent: 100, perMinute: 100, perDay: 3 })).toEqual({ granted: 3, refusals: new Set(["workspace_day"]) });
  });

  it("records a run only when granted, and only for a workspace the caller belongs to", async () => {
    const refused = await bob.client.rpc("claim_run", { ws: aliceWs, p_concurrent: 5, p_per_minute: 5, p_per_day: 5 });
    expect(refused.error).not.toBeNull();
    const before = await alice.client.from("usage_events").select("id").eq("workspace_id", aliceWs);
    const over = await alice.client.rpc("claim_run", { ws: aliceWs, p_concurrent: 5, p_per_minute: 5, p_per_day: before.data!.length });
    expect(over.data).toBe("workspace_day");
    const after = await alice.client.from("usage_events").select("id").eq("workspace_id", aliceWs);
    expect(after.data!.length).toBe(before.data!.length);
  });
});

describe("direct Storage uploads", () => {
  const upload = (account: TestAccount, ws: string, name: string, contentType: string) =>
    account.client.storage
      .from("attachments")
      .upload(`${ws}/${account.userId}/${crypto.randomUUID()}/${name}`, new Blob(["MZ"], { type: contentType }), { contentType });

  it("accept only the app's file types, by declared type and by extension", async () => {
    expect((await upload(alice, aliceWs, "notes.txt", "text/plain")).error).toBeNull();
    expect((await upload(alice, aliceWs, "tool.exe", "application/x-msdownload")).error).not.toBeNull();
    expect((await upload(alice, aliceWs, "tool.exe", "text/plain")).error).not.toBeNull();
    expect((await upload(alice, aliceWs, "page.svg", "image/png")).error).not.toBeNull();
    expect((await upload(alice, aliceWs, "notes.txt", "application/x-msdownload")).error).not.toBeNull();
  });
});

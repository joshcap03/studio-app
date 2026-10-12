import { describe, expect, it } from "vitest";
import { createSessionToken, passwordMatches, verifySessionToken, SESSION_MAX_AGE_SECONDS } from "./session";

const secret = "test-secret-that-is-long-enough-0123456789";

describe("session tokens", () => {
  it("round-trips a signed token", async () => {
    const token = await createSessionToken("owner", secret, 1_000_000);
    expect(await verifySessionToken(token, secret, 1_000_000)).toEqual({ userId: "owner" });
  });

  it("rejects a token signed with another secret", async () => {
    const token = await createSessionToken("owner", secret);
    expect(await verifySessionToken(token, "another-secret-that-is-long-enough-012345")).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await createSessionToken("owner", secret);
    const [, signature] = token.split(".");
    const forged = btoa(JSON.stringify({ sub: "someone-else", exp: 9_999_999_999 })).replace(/=+$/, "");
    expect(await verifySessionToken(`${forged}.${signature}`, secret)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const issued = 1_000_000;
    const token = await createSessionToken("owner", secret, issued);
    const later = issued + (SESSION_MAX_AGE_SECONDS + 1) * 1000;
    expect(await verifySessionToken(token, secret, later)).toBeNull();
  });

  it("rejects malformed input", async () => {
    for (const bad of [undefined, "", "abc", "a.b.c", "!!!.???"]) {
      expect(await verifySessionToken(bad, secret)).toBeNull();
    }
  });

  it("compares passwords", async () => {
    expect(await passwordMatches("correct horse", "correct horse")).toBe(true);
    expect(await passwordMatches("correct horse!", "correct horse")).toBe(false);
  });
});

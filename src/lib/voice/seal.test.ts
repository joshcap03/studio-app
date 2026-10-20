import { describe, expect, it } from "vitest";
import { clipKey, openContext, sealContext } from "./seal";
import type { VoiceContext } from "./types";

const secret = "s".repeat(40);
const context: VoiceContext = {
  v: 1,
  sid: "11111111-1111-4111-8111-111111111111",
  cid: "conv_alice",
  provider: "elevenlabs",
  uid: "alice",
  ws: "ws_alice",
  exp: Date.now() + 60_000,
  name: "Rowan",
  agent: "Job search",
  guardrail: "Don't decide for me.",
};

describe("voice context seal", () => {
  it("opens for the call it was sealed for", () => {
    expect(openContext(sealContext(context, secret), "conv_alice", secret)).toEqual(context);
  });

  it("refuses another call, another key, an edit, or an expired seal", () => {
    const sealed = sealContext(context, secret);
    expect(openContext(sealed, "conv_bob", secret)).toBeNull();
    expect(openContext(sealed, "conv_alice", "t".repeat(40))).toBeNull();
    const [payload, mac] = sealed.split(".");
    const stripped = Buffer.from(JSON.stringify({ ...context, guardrail: null })).toString("base64url");
    expect(openContext(`${stripped}.${mac}`, "conv_alice", secret)).toBeNull();
    expect(openContext(`${payload}.${mac}x`, "conv_alice", secret)).toBeNull();
    expect(openContext(sealContext({ ...context, exp: Date.now() - 1 }, secret), "conv_alice", secret)).toBeNull();
    expect(openContext(null, "conv_alice", secret)).toBeNull();
    expect(openContext(sealed, null, secret)).toBeNull();
  });
});

describe("voice clip keys", () => {
  it("name a clip the same way every time, never as the plain name, and can't be made without the key", () => {
    const key = clipKey("preview", "preview:warm:v1", secret);
    expect(key).toBe(clipKey("preview", "preview:warm:v1", secret));
    expect(key).not.toContain("warm");
    // Fits the ledger's ref (1-200 characters).
    expect(key.length).toBeGreaterThan(0);
    expect(key.length).toBeLessThanOrEqual(200);
    expect(clipKey("note", "preview:warm:v1", secret)).not.toBe(key);
    expect(clipKey("preview", "preview:bright:v1", secret)).not.toBe(key);
    expect(clipKey("preview", "preview:warm:v1", "t".repeat(40))).not.toBe(key);
  });
});

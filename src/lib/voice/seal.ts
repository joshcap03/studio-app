import { createHmac, timingSafeEqual } from "node:crypto";
import type { VoiceContext } from "./types";

// The voice context is sealed when a call starts, under the member's session, and checked on
// every request the voice provider makes to the voice front, which has no member session (the
// provider calls it, not the member). The seal is an HMAC: the browser carries the context but
// can't change it (that would strip a guardrail) or move it to another call (it's bound to the
// provider's conversation id, which the provider sends in its own header). Not encrypted: it
// holds only what the member may already see. Server-only.

const encode = (value: string | Buffer) => Buffer.from(value).toString("base64url");

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`studio-voice:${payload}`).digest("base64url");
}

export function sealContext(context: VoiceContext, secret: string): string {
  const payload = encode(JSON.stringify(context));
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * The context, when the seal is intact, unexpired, and bound to `conversationId`; otherwise
 * null. Every failure looks the same to the caller.
 */
export function openContext(sealed: string | null | undefined, conversationId: string | null | undefined, secret: string, now = Date.now()): VoiceContext | null {
  if (!sealed || !conversationId || sealed.length > 16_000) return null;
  const [payload, mac, extra] = sealed.split(".");
  if (!payload || !mac || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let context: VoiceContext;
  try {
    context = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as VoiceContext;
  } catch {
    return null;
  }
  if (context?.v !== 1 || typeof context.exp !== "number" || context.exp < now) return null;
  if (context.cid !== conversationId) return null;
  return context;
}

/**
 * The name a clip of speech goes by in the member's voice ledger (voice_clips): a keyed hash of
 * the app's own name for it. A member can call claim_voice_clip themselves, and could work out a
 * plain name (a message id and a hash of words they can read), so a row they wrote would pass
 * for a clip already paid for. Without the key they can only charge themselves.
 */
export function clipKey(kind: string, ref: string, secret: string): string {
  return createHmac("sha256", secret).update(`studio-voice-clip:${kind}:${ref}`).digest("base64url");
}

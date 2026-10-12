// Signed session tokens built on Web Crypto, so the same code runs in the proxy and in
// route handlers. Token format: base64url(JSON payload) "." base64url(HMAC-SHA256).

export const SESSION_COOKIE = "lj_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/** The single account for this MVP. The data model is keyed by user id throughout. */
export const OWNER_USER_ID = "owner";

interface SessionPayload {
  sub: string;
  exp: number;
}

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export async function createSessionToken(userId: string, secret: string, now = Date.now()): Promise<string> {
  const payload: SessionPayload = { sub: userId, exp: Math.floor(now / 1000) + SESSION_MAX_AGE_SECONDS };
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifySessionToken(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<{ userId: string } | null> {
  if (!token) return null;
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;
  const sigBytes = fromBase64Url(signature);
  if (!sigBytes) return null;
  // crypto.subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), sigBytes, encoder.encode(body));
  if (!valid) return null;
  const json = fromBase64Url(body);
  if (!json) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(json)) as Partial<SessionPayload>;
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 <= now) return null;
    return { userId: payload.sub };
  } catch {
    return null;
  }
}

/** Constant-time password comparison via digests of equal length. */
export async function passwordMatches(candidate: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

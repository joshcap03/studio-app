import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getConfig } from "@/lib/config";
import type { Session } from "@/lib/tenant-core";
import { cardBrand } from "./card";

// A person's saved logins and cards, for filling into the agent's browser (src/lib/browser-fill.ts).
// They belong to the person, so all their agents share them. What's secret is sealed here with the
// app's own key (AES-256-GCM, bound to the person and the kind) and then kept in Supabase Vault,
// all under the member's own session (supabase/migrations/20261107000000_credentials.sql). Nothing
// here logs, returns to the page, or sends to the agent a secret's value: callers get it only to
// type it into the browser. A card's security code is never saved.
//
// Free of next/*.

export type CredentialKind = "login" | "card";

export interface LoginSecret {
  password: string;
}
export interface CardSecret {
  number: string;
  name: string;
  /** "04" */
  expMonth: string;
  /** Two digits: "27". */
  expYear: string;
}

/** What the member sees of a saved credential: never its secret. */
export interface CredentialSummary {
  id: string;
  kind: CredentialKind;
  label: string;
  /** A login's site, the exact https origin it fills on. */
  origin?: string;
  username?: string;
  brand?: string;
  last4?: string;
  /** "MM/YY" */
  exp?: string;
  lastUsedAt: number | null;
}

interface Row {
  id: string;
  kind: CredentialKind;
  label: string;
  origin: string | null;
  username: string | null;
  card_brand: string | null;
  card_last4: string | null;
  card_exp: string | null;
  last_used_at: string | null;
}

const COLUMNS = "id, kind, label, origin, username, card_brand, card_last4, card_exp, last_used_at";

function summary(row: Row): CredentialSummary {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    ...(row.origin ? { origin: row.origin } : {}),
    ...(row.username ? { username: row.username } : {}),
    ...(row.card_brand ? { brand: row.card_brand } : {}),
    ...(row.card_last4 ? { last4: row.card_last4 } : {}),
    ...(row.card_exp ? { exp: row.card_exp } : {}),
    lastUsedAt: row.last_used_at ? Date.parse(row.last_used_at) : null,
  };
}

/** Whether saving is set up (the app's sealing key is configured). */
export function credentialsEnabled(): boolean {
  return Boolean(getConfig().credentials);
}

function key(): Buffer {
  const credentials = getConfig().credentials;
  if (!credentials) throw new Error("Saving logins and cards isn't set up.");
  return credentials.key;
}

const aad = (userId: string, kind: CredentialKind) => Buffer.from(`studio-credential:v1:${userId}:${kind}`);

/** Seals a secret to one person and kind: "v1.<iv>.<tag>.<ciphertext>", base64url. */
export function seal(sealKey: Buffer, userId: string, kind: CredentialKind, secret: LoginSecret | CardSecret): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey, iv);
  cipher.setAAD(aad(userId, kind));
  const body = Buffer.concat([cipher.update(JSON.stringify(secret), "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), body].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/** The secret, if `sealed` was sealed with this key for this person and kind; null otherwise. */
export function unseal(sealKey: Buffer, userId: string, kind: CredentialKind, sealed: string): LoginSecret | CardSecret | null {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", sealKey, Buffer.from(iv, "base64url"));
    decipher.setAAD(aad(userId, kind));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const text = Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
    return JSON.parse(text) as LoginSecret | CardSecret;
  } catch {
    return null;
  }
}

/** The caller's saved credentials, most recently used first: logins for one site, or cards. */
export async function listCredentials(session: Session, filter: { kind?: CredentialKind; origin?: string } = {}): Promise<CredentialSummary[]> {
  let query = session.db.from("credentials").select(COLUMNS).eq("user_id", session.userId);
  if (filter.kind) query = query.eq("kind", filter.kind);
  if (filter.origin) query = query.eq("origin", filter.origin);
  const { data, error } = await query.order("last_used_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  return (data as Row[]).map(summary);
}

/** Saves a login for one site, replacing one already saved there for the same username. */
export async function saveLogin(session: Session, login: { origin: string; username: string; password: string; label?: string }): Promise<string> {
  const host = new URL(login.origin).hostname.replace(/^www\./, "");
  const { data, error } = await session.db.rpc("save_credential", {
    p_kind: "login",
    p_label: (login.label?.trim() || (login.username ? `${host} · ${login.username}` : host)).slice(0, 80),
    p_sealed: seal(key(), session.userId, "login", { password: login.password }),
    p_origin: login.origin,
    p_username: login.username || null,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

/** Saves a card on file (never its security code). `card.number` is digits only, already checked. */
export async function saveCard(session: Session, card: CardSecret & { label?: string }): Promise<string> {
  const brand = cardBrand(card.number);
  const last4 = card.number.slice(-4);
  const { data, error } = await session.db.rpc("save_credential", {
    p_kind: "card",
    p_label: (card.label?.trim() || `${brand} ending ${last4}`).slice(0, 80),
    p_sealed: seal(key(), session.userId, "card", { number: card.number, name: card.name, expMonth: card.expMonth, expYear: card.expYear }),
    p_card_brand: brand,
    p_card_last4: last4,
    p_card_exp: `${card.expMonth}/${card.expYear}`,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

/**
 * One of the caller's saved credentials with its secret, to type into the browser now (it's
 * marked used). Null when it isn't theirs, is gone, or can't be opened with this app's key.
 */
export async function revealCredential(
  session: Session,
  id: string,
): Promise<{ credential: CredentialSummary; login: LoginSecret } | { credential: CredentialSummary; card: CardSecret } | null> {
  const { data: row, error } = await session.db.from("credentials").select(COLUMNS).eq("id", id).eq("user_id", session.userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) return null;
  const { data: sealed, error: revealError } = await session.db.rpc("reveal_credential", { p_id: id });
  if (revealError) throw new Error(revealError.message);
  if (typeof sealed !== "string") return null;
  const credential = summary(row as Row);
  const secret = unseal(key(), session.userId, credential.kind, sealed);
  if (!secret) return null;
  return credential.kind === "login" ? { credential, login: secret as LoginSecret } : { credential, card: secret as CardSecret };
}

/** Removes one of the caller's saved credentials. Whether there was one. */
export async function deleteCredential(session: Session, id: string): Promise<boolean> {
  const { data, error } = await session.db.rpc("delete_credential", { p_id: id });
  if (error) throw new Error(error.message);
  return data === true;
}

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { isCrossSite, isSameOrigin } from "@/lib/same-origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveTenant, sessionFor, type Session, type Tenant } from "@/lib/tenant-core";

export { isSameOrigin, resolveTenant, sessionFor, type Session, type Tenant };

// Identity and tenancy are derived only from the authenticated session. The active
// workspace is a preference cookie, honored only if the user is actually a member of it
// (checked against the database under RLS); request bodies and URLs never choose it.

export const ACTIVE_WORKSPACE_COOKIE = "lj_ws";

export async function getSession(): Promise<Session | null> {
  const db = await createSupabaseServerClient();
  // getUser() validates the token with Supabase Auth instead of trusting the cookie.
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) return null;
  return sessionFor(db, data.user);
}

/** For server components: signed out → /login, no workspace yet → onboarding. */
export async function requirePageTenant(): Promise<Tenant> {
  const session = await getSession();
  if (!session) redirect("/login");
  const preferred = (await cookies()).get(ACTIVE_WORKSPACE_COOKIE)?.value;
  const tenant = await resolveTenant(session, preferred);
  if (!tenant) redirect("/onboarding");
  return tenant;
}

export function jsonError(status: number, message: string, code?: string): NextResponse {
  return NextResponse.json({ error: message, code }, { status, headers: { "Cache-Control": "no-store" } });
}

type Authorized<T> = { ok: true; value: T } | { ok: false; response: NextResponse };

/**
 * `writes`: a GET that changes something anyway (it charges voice time, say). A session cookie
 * rides along on another site's link or popup, so the browser's word on where it came from counts.
 */
type Options = { writes?: boolean };

/** Authenticates an API request and rejects cross-origin writes. */
export async function authorizeSession(request: NextRequest, { writes = false }: Options = {}): Promise<Authorized<Session>> {
  const refused = isReadOnly(request) ? writes && isCrossSite(request) : !isSameOrigin(request);
  if (refused) {
    return { ok: false, response: jsonError(403, "Cross-origin request refused.") };
  }
  const session = await getSession();
  if (!session) return { ok: false, response: jsonError(401, "Not signed in.") };
  return { ok: true, value: session };
}

/** Authenticates an API request and resolves the caller's active workspace. */
export async function authorizeTenant(request: NextRequest, options: Options = {}): Promise<Authorized<Tenant>> {
  const auth = await authorizeSession(request, options);
  if (!auth.ok) return auth;
  const tenant = await resolveTenant(auth.value, request.cookies.get(ACTIVE_WORKSPACE_COOKIE)?.value);
  if (!tenant) return { ok: false, response: jsonError(409, "Create an agent first.", "no_workspace") };
  return { ok: true, value: tenant };
}

function isReadOnly(request: NextRequest): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

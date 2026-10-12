import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { SESSION_COOKIE, verifySessionToken } from "./session";

/** Session for server components. Returns null when signed out. */
export async function getSession(): Promise<{ userId: string } | null> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value, getConfig().sessionSecret);
}

export function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Authorizes an API request. The proxy already rejects unauthenticated traffic; this is the
 * authoritative check. State-changing requests must also come from this origin (CSRF guard
 * on top of the SameSite cookie).
 */
export async function authorize(
  request: NextRequest,
): Promise<{ ok: true; userId: string } | { ok: false; response: NextResponse }> {
  const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value, getConfig().sessionSecret);
  if (!session) return { ok: false, response: jsonError(401, "Not signed in.") };
  if (request.method !== "GET" && request.method !== "HEAD" && !isSameOrigin(request)) {
    return { ok: false, response: jsonError(403, "Cross-origin request refused.") };
  }
  return { ok: true, userId: session.userId };
}

export function isSameOrigin(request: NextRequest): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin) return fetchSite === "same-origin";
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

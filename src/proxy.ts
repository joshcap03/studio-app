import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";

// Gatekeeper for every page and API route except sign-in. Route handlers verify the session
// again; this layer keeps unauthenticated traffic away from the app entirely.

export async function proxy(request: NextRequest) {
  const secret = process.env.SESSION_SECRET;
  const session = secret ? await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value, secret) : null;
  if (session) return NextResponse.next();

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  const next = request.nextUrl.pathname + request.nextUrl.search;
  if (next !== "/") login.searchParams.set("next", next);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!login|api/auth/login|_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)"],
};

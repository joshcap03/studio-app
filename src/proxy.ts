import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Refreshes the Supabase session on every request and keeps signed-out traffic away from
// the app. Route handlers and pages verify the user again; this is the outer gate.

const PUBLIC_PATHS = ["/login", "/auth/confirm", "/api/auth/"];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.json({ error: "Supabase is not configured." }, { status: 500 });

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });
  const { data } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  if (data.user || PUBLIC_PATHS.some((p) => path.startsWith(p)) || isWorkerRunStart(request)) return response;

  if (path.startsWith("/api/")) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const login = new URL("/login", request.url);
  const next = path + request.nextUrl.search;
  if (next !== "/") login.searchParams.set("next", next);
  return NextResponse.redirect(login);
}

// The background worker starting a queued task run carries the member's access token instead
// of a cookie. Only that one route takes a token, and it verifies it with Supabase Auth itself
// (src/app/api/tasks/[id]/runs/[runId]/route.ts); nothing else gets past without a session.
const WORKER_RUN_START = /^\/api\/tasks\/[0-9a-f-]{36}\/runs\/[0-9a-f-]{36}$/i;

function isWorkerRunStart(request: NextRequest): boolean {
  return request.method === "POST" && WORKER_RUN_START.test(request.nextUrl.pathname) && /^Bearer\s+\S+$/i.test(request.headers.get("authorization") ?? "");
}

export const config = {
  // The app manifest, service worker, and home-screen icons load without a session (iOS
  // fetches the manifest without cookies).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|manifest.webmanifest|sw.js|icon-192.png|icon-512.png|apple-touch-icon.png).*)",
  ],
};
